#!/bin/bash
# setup-premium-proxy.sh — wire a residential proxy into OmniRoute on the EC2
# instance so the premium pools (Claude, GPT-5, Gemini via aug/tllm/ddgw) work.
#
# These pools block datacenter and cloud egress IPs ("blocked by Vercel for
# this server egress IP", stream_early_eof). They only answer when the request
# egresses from a residential IP. This script configures OmniRoute to route
# premium-pool traffic through such a proxy and verifies it live.
#
# Run this ON the instance (or via SSM). Pick ONE mode:
#
#   A) Webshare (free tier — 10 proxies, 1 GB/mo, needs a free account):
#        OR_ADMIN_PASSWORD=... bash scripts/setup-premium-proxy.sh --webshare-key <API_KEY>
#      Get the key at https://proxy.webshare.io -> API -> Generate.
#
#   B) Any proxy-list URL (OneProxy pool provider-source):
#        OR_ADMIN_PASSWORD=... bash scripts/setup-premium-proxy.sh --oneproxy-url 'https://...'
#
#   C) One residential proxy (host:port, optional user/pass):
#        OR_ADMIN_PASSWORD=... bash scripts/setup-premium-proxy.sh \
#          --proxy host:port --user user --pass pass
#
# Auth: OmniRoute's management API needs the dashboard password. The current
# instance password was reset during setup (see the deploy notes); pass it via
# OR_ADMIN_PASSWORD so it never lands in git.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:20128}"
PASS="${OR_ADMIN_PASSWORD:-}"
ENV_FILE=/root/.omniroute/.env

# Which premium providers the proxy should cover. tllm/aug/ddgw are the
# pools observed blocked from datacenter egress.
PREMIUM_PROVIDERS=(tllm aug ddgw)

usage() { sed -n '2,30p' "$0" | grep -E '^\s*#' | sed 's/^\s*# \{0,1\}//'; exit 1; }

# ---- parse args ----
MODE=""
WEBSHARE_KEY=""
ONEPROXY_URL=""
PROXY_HOSTPORT=""
PROXY_USER=""
PROXY_PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --webshare-key) WEBSHARE_KEY="$2"; MODE="webshare"; shift 2 ;;
    --oneproxy-url) ONEPROXY_URL="$2"; MODE="oneproxy"; shift 2 ;;
    --proxy) PROXY_HOSTPORT="$2"; MODE="direct"; shift 2 ;;
    --user) PROXY_USER="$2"; shift 2 ;;
    --pass) PROXY_PASS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$MODE" ] || { echo "ERROR: pick one mode (--webshare-key | --oneproxy-url | --proxy)" >&2; usage; }
[ -n "$PASS" ] || { echo "ERROR: set OR_ADMIN_PASSWORD (OmniRoute dashboard password)" >&2; exit 1; }

echo "=== setup-premium-proxy: mode=$MODE ==="

# ---- login and get a session token ----
TOK=$(curl -fsS --max-time 10 -D - -o /dev/null -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" 2>/dev/null \
  | grep -i '^set-cookie: auth_token=' | sed 's/^[Ss]et-[Cc]ookie: auth_token=//' | cut -d';' -f1)
[ -n "$TOK" ] || { echo "ERROR: OmniRoute login failed (wrong OR_ADMIN_PASSWORD?)" >&2; exit 1; }
CURL=(curl -fsS --max-time 15 -H "Cookie: auth_token=$TOK" -H 'Content-Type: application/json')

api() { # api METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    "${CURL[@]}" -X "$method" "$BASE$path" -d "$body"
  else
    "${CURL[@]}" -X "$method" "$BASE$path"
  fi
}

restart_omniroute() {
  systemctl restart omniroute
  sleep 6
  systemctl is-active --quiet omniroute || { echo "ERROR: omniroute failed to restart" >&2; exit 1; }
  echo "omniroute restarted"
}

relogin() {
  TOK=$(curl -fsS --max-time 10 -D - -o /dev/null -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" 2>/dev/null \
    | grep -i '^set-cookie: auth_token=' | sed 's/^[Ss]et-[Cc]ookie: auth_token=//' | cut -d';' -f1)
  CURL=(curl -fsS --max-time 15 -H "Cookie: auth_token=$TOK" -H 'Content-Type: application/json')
}

# ---- apply configuration per mode ----
case "$MODE" in
  webshare)
    # OmniRoute has a built-in Webshare provider; it syncs the account's
    # proxy list into the pool. Free tier: 10 proxies / 1 GB per month.
    touch "$ENV_FILE"
    grep -q '^FREE_PROXY_WEBSHARE_API_KEY=' "$ENV_FILE" \
      && sed -i "s|^FREE_PROXY_WEBSHARE_API_KEY=.*|FREE_PROXY_WEBSHARE_API_KEY=$WEBSHARE_KEY|" "$ENV_FILE" \
      || echo "FREE_PROXY_WEBSHARE_API_KEY=$WEBSHARE_KEY" >> "$ENV_FILE"
    grep -q '^FREE_PROXY_AUTO_SYNC_ENABLED=' "$ENV_FILE" \
      && sed -i 's|^FREE_PROXY_AUTO_SYNC_ENABLED=.*|FREE_PROXY_AUTO_SYNC_ENABLED=true|' "$ENV_FILE" \
      || echo "FREE_PROXY_AUTO_SYNC_ENABLED=true" >> "$ENV_FILE"
    restart_omniroute
    relogin
    echo "syncing Webshare proxy list..."
    api POST /api/settings/free-proxies/sync '{}' | head -c 400; echo
    ;;

  oneproxy)
    # OneProxy pool — provider-source is any URL serving a proxy list. The
    # pool is synced by the free-proxies cycle, so we configure it and then
    # trigger a sync.
    api PUT /api/settings/oneproxy \
      "{\"enabled\":true,\"providerSource\":\"$ONEPROXY_URL\",\"poolSize\":20,\"rotationPolicy\":\"round-robin\"}" \
      | head -c 300; echo
    echo "syncing proxy pool..."
    api POST /api/settings/free-proxies/sync '{}' | head -c 400; echo
    ;;

  direct)
    # One residential proxy, assigned to each premium provider + global fallback.
    HOST="${PROXY_HOSTPORT%:*}"; PORT="${PROXY_HOSTPORT##*:}"
    [ -n "$HOST" ] && [ -n "$PORT" ] || { echo "ERROR: --proxy must be host:port" >&2; exit 1; }
    BODY=$(python3 -c "
import json,sys
host,port,user,psw = '$HOST','$PORT','$PROXY_USER','$PROXY_PASS'
p = {'name':'residential-premium','type':'http','host':host,'port':int(port),'family':'residential'}
if user: p['username']=user; p['password']=psw
print(json.dumps(p))
")
    for prov in "${PREMIUM_PROVIDERS[@]}"; do
      BODY2=$(python3 -c "
import json
b=json.loads('''$BODY''')
b['assignment']={'scope':'provider','scopeId':'$prov'}
print(json.dumps(b))
")
      echo "assigning proxy -> provider $prov"
      api POST /api/settings/proxies "$BODY2" | head -c 250; echo
    done
    # Global fallback so any other blocked pool benefits too
    BODY3=$(python3 -c "
import json
b=json.loads('''$BODY''')
b['assignment']={'scope':'global'}
print(json.dumps(b))
")
    echo "assigning proxy -> global"
    api POST /api/settings/proxies "$BODY3" | head -c 250; echo
    ;;
esac

# ---- verification: pool, egress IP, then a real premium request ----
echo
echo "=== proxy pool status ==="
api GET /api/settings/oneproxy | head -c 400; echo
echo
echo "=== egress IP through the pool ==="
api POST /api/settings/proxies/auto-test '{}' | head -c 300; echo

echo
echo "=== live premium-model tests (Claude via aug, GPT-5 via tllm) ==="
sleep 5
for M in aug/claude-sonnet tllm/GPT_5_4 ddgw/gpt-5.4-mini; do
  R=$(curl -sS --max-time 90 -X POST "$BASE/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PREMIUM_OK\"}],\"max_tokens\":10}" 2>&1 \
    | head -c 220)
  echo "$M -> ${R:-no response}"
done

echo
echo "=== done. If any test above answered, premium models now work on the live site. ==="
