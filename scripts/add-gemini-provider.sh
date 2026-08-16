#!/usr/bin/env bash
# =============================================================================
# add-gemini-provider.sh — wire a Gemini API key into the OmniRoute gateway on
# the EC2 instance so Gemini models (incl. vision) work on the live site.
#
# Usage:
#   ./scripts/add-gemini-provider.sh <API_KEY>
#
# The key is a Google AI Studio key (https://aistudio.google.com/apikey) —
# free tier works from the EC2 datacenter IP, no residential proxy needed.
#
# What it does, all against the localhost OmniRoute dashboard API:
#   1. Logs in (password reset earlier; dashboard is never exposed publicly)
#   2. Validates the key   -> POST /api/providers/validate
#   3. Creates the provider-> POST /api/providers
#   4. Confirms it appears in the provider list
#   5. Tests a real Gemini chat request through the gateway
#   6. Tests a real Gemini VISION request (image) through the gateway
#   7. Asks PixGPT to refresh its model registry so the catalog picks it up
# =============================================================================
set -euo pipefail

KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  echo "usage: $0 <GEMINI_API_KEY>" >&2
  echo "get a free key at https://aistudio.google.com/apikey" >&2
  exit 2
fi
if [[ "$KEY" != AIza* ]]; then
  echo "error: a Gemini API key starts with 'AIza...' — got '$KEY'" >&2
  exit 2
fi

BASE="http://127.0.0.1:20128"
PW="${OMNIROUTE_ADMIN_PASSWORD:-Pr0xyC0nfig!2026}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

say()  { printf '\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m   %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m   %s\033[0m\n' "$*"; }

# --- 1. login ----------------------------------------------------------------
say "Logging into the OmniRoute dashboard (localhost)"
LOGIN=$(curl -sS -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PW\"}" -w '\n%{http_code}')
CODE=$(tail -n1 <<<"$LOGIN")
if [[ "$CODE" != "200" ]]; then
  fail "login failed (http $CODE). Set OMNIROUTE_ADMIN_PASSWORD if it changed."
  exit 1
fi
ok "authenticated"

# --- 2. validate -------------------------------------------------------------
say "Validating the Gemini API key"
VALID=$(curl -sS -b "$JAR" -X POST "$BASE/api/providers/validate" \
  -H "Content-Type: application/json" \
  -d "{\"provider\":\"gemini\",\"apiKey\":\"$KEY\"}")
if grep -q '"valid":false' <<<"$VALID"; then
  fail "key rejected by Google: $(sed -E 's/.*"error":"([^"]*)".*/\1/' <<<"$VALID")"
  exit 1
fi
ok "key valid: $(head -c 120 <<<"$VALID")"

# --- 3. create ---------------------------------------------------------------
say "Creating the 'Gemini' provider in OmniRoute"
CREATE=$(curl -sS -b "$JAR" -X POST "$BASE/api/providers" \
  -H "Content-Type: application/json" \
  -d "{\"provider\":\"gemini\",\"apiKey\":\"$KEY\",\"name\":\"Gemini\"}")
if grep -q '"error"' <<<"$CREATE"; then
  fail "create failed: $(head -c 300 <<<"$CREATE")"
  exit 1
fi
ok "created: $(head -c 200 <<<"$CREATE")"

# --- 4. list -----------------------------------------------------------------
say "Confirming the provider is registered"
LIST=$(curl -sS -b "$JAR" "$BASE/api/providers")
if ! grep -qi 'gemini' <<<"$LIST"; then
  fail "provider not visible in the list yet — check the dashboard."
else
  ok "gemini provider present in the registry"
fi

# --- 5. real chat test -------------------------------------------------------
say "Testing a real Gemini chat request through the gateway"
CHAT=$(curl -sS --max-time 60 -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-omniroute" \
  -d '{"model":"gemini/gemini-2.5-flash","messages":[{"role":"user","content":"Reply with the single word: GEMINI_OK"}],"stream":false}' | head -c 500)
if grep -qi '"error"' <<<"$CHAT"; then
  fail "chat request errored: $(head -c 300 <<<"$CHAT")"
else
  ok "chat ok: $(head -c 200 <<<"$CHAT")"
fi

# --- 6. vision test ----------------------------------------------------------
say "Testing a real Gemini VISION request (1x1 png)"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
VISION=$(curl -sS --max-time 90 -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-omniroute" \
  -d "{\"model\":\"gemini/gemini-2.5-flash\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What color is this image? One word.\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,$PNG\"}}]}],\"stream\":false}" | head -c 500)
if grep -qi '"error"' <<<"$VISION"; then
  fail "vision request errored: $(head -c 300 <<<"$VISION")"
else
  ok "vision ok: $(head -c 200 <<<"$VISION")"
fi

# --- 7. refresh PixGPT registry ----------------------------------------------
say "Refreshing PixGPT's model registry so the catalog sees Gemini"
REFRESH=$(curl -sS --max-time 30 -X POST "http://127.0.0.1:80/api/models/refresh" | head -c 200)
ok "refresh: $(head -c 150 <<<"$REFRESH")"

echo
printf '\033[1;32mDONE — Gemini is wired into OmniRoute.\033[0m\n'
echo "Next: set OMNIROUTE_MODEL_VISION=gemini/gemini-2.5-flash (or add it to"
echo "OMNIROUTE_VISION_FALLBACK_MODELS) on the instance, then restart pixgpt,"
echo "so the pixgpt-vision alias uses Gemini for real image analysis."
