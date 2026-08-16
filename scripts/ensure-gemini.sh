#!/usr/bin/env bash
# =============================================================================
# ensure-gemini.sh — run ON the EC2 instance (bootstrap + every deploy).
#
# If the private config bucket holds a gemini.env (the operator added a Gemini
# API key), this:
#   1. Creates the "Gemini" provider in OmniRoute if it is missing
#      (the OmniRoute DB is shipped from the operator's machine, so a fresh
#      instance never has it unless this runs).
#   2. Merges the OMNIROUTE_* settings from gemini.env into /opt/pixgpt/.env
#      so the vision alias and fallback chains use Gemini.
#
# Without gemini.env in the bucket it exits silently — deployments without a
# Gemini key are unaffected.
# =============================================================================
set -uo pipefail

BUCKET="${CONFIG_BUCKET:-pixgpt-omniroute-config-276699357742}"
ENV_FILE=/opt/pixgpt/.env
BASE="http://127.0.0.1:20128"

# --- fetch the Gemini secrets (if any) --------------------------------------
if ! aws s3 cp "s3://$BUCKET/gemini.env" /tmp/gemini.env --quiet 2>/dev/null; then
  echo "ensure-gemini: no gemini.env in s3://$BUCKET — skipping"
  exit 0
fi

sed -i 's/\r$//' /tmp/gemini.env 2>/dev/null || true
KEY="$(sed -nE 's/^GEMINI_API_KEY=(.*)$/\1/p' /tmp/gemini.env | head -1)"
if [[ -z "$KEY" ]]; then
  echo "ensure-gemini: gemini.env present but GEMINI_API_KEY empty — skipping"
  exit 0
fi
echo "ensure-gemini: Gemini key found (${KEY:0:5}…), ensuring provider + env"

# --- OmniRoute dashboard auth (localhost-only) -------------------------------
PW="${OMNIROUTE_ADMIN_PASSWORD:-Pr0xyC0nfig!2026}"
JAR="$(mktemp)"
trap 'rm -f "$JAR" /tmp/gemini.env' EXIT

LOGIN=$(curl -sS -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PW\"}" -w '\n%{http_code}')
CODE=$(tail -n1 <<<"$LOGIN")
if [[ "$CODE" != "200" ]]; then
  echo "ensure-gemini: dashboard login failed (http $CODE) — provider not ensured"
  exit 0
fi

# --- create the provider if missing ------------------------------------------
if ! curl -sS -b "$JAR" "$BASE/api/providers" | grep -qi '"provider":"gemini"'; then
  CREATE=$(curl -sS -b "$JAR" -X POST "$BASE/api/providers" \
    -H "Content-Type: application/json" \
    -d "{\"provider\":\"gemini\",\"apiKey\":\"$KEY\",\"name\":\"Gemini\"}")
  if grep -q '"error"' <<<"$CREATE"; then
    echo "ensure-gemini: provider create failed: $(head -c 200 <<<"$CREATE")"
    exit 0
  fi
  echo "ensure-gemini: Gemini provider created"
else
  echo "ensure-gemini: Gemini provider already registered"
fi

# --- merge the OMNIROUTE_* settings into /opt/pixgpt/.env --------------------
# gemini.env may carry: OMNIROUTE_MODEL_VISION, OMNIROUTE_VISION_FALLBACK_MODELS,
# OMNIROUTE_FALLBACK_MODELS — each replaces the line in the app env.
APPLIED=0
while IFS= read -r LINE; do
  case "$LINE" in
    OMNIROUTE_*=*)
      NAME="${LINE%%=*}"
      if grep -qE "^$NAME=" "$ENV_FILE"; then
        sed -i "s|^$NAME=.*|$LINE|" "$ENV_FILE"
      else
        echo "$LINE" >> "$ENV_FILE"
      fi
      APPLIED=1
      echo "ensure-gemini: set $NAME"
      ;;
  esac
done < <(grep -E '^OMNIROUTE_[A-Za-z0-9_]*=' /tmp/gemini.env || true)

if [[ "$APPLIED" == "1" ]]; then
  # The app reads the env file fresh on each start; nothing else to do — the
  # caller restarts pixgpt after this script.
  echo "ensure-gemini: env updated"
fi
