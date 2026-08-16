#!/bin/bash
# Runs ON the EC2 instance (invoked by GitHub Actions via SSM Run Command).
# Pulls the latest main, rebuilds, restarts the services, and verifies.
set -euo pipefail

cd /opt/pixgpt

echo "=== deploy $(date -u) ==="
git fetch origin main
git checkout --force FETCH_HEAD
echo "HEAD=$(git rev-parse --short HEAD)"

npm ci --no-audit --no-fund

# Production build — talks to the real OmniRoute gateway (never demo mode).
# The gateway is a separate service; the build does not need it, only the
# running server does.
npm run build

# Make sure the AI gateway is up before the app (config lives in
# /root/.omniroute, fetched at bootstrap and not touched by deploys).
systemctl is-active --quiet omniroute || systemctl start omniroute

# If the operator added a Gemini key (gemini.env in the config bucket), ensure
# the provider exists in OmniRoute and merge its routing env into the app env.
# Idempotent; a no-op when no key is configured.
bash scripts/ensure-gemini.sh || true

systemctl restart pixgpt

# The server takes a few seconds after restart to probe the gateway and
# warm the model catalogue; a single immediate health check would fail
# with reachable:false (code=timeout). Poll until it reports healthy.
for i in $(seq 1 12); do
  sleep 5
  HTTP=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost/ || echo failed)
  HEALTH=$(curl -fsS --max-time 10 http://localhost/api/health || true)
  if echo "$HEALTH" | grep -q '"reachable":true'; then
    echo "services: omniroute=$(systemctl is-active omniroute) pixgpt=$(systemctl is-active pixgpt)"
    echo "http=$HTTP"
    echo "health=$HEALTH"
    echo "gateway=ok"
    echo "=== deploy done $(date -u) ==="
    exit 0
  fi
  echo "waiting for gateway... ($i/12) http=$HTTP health=$(echo "$HEALTH" | head -c 120)"
done

echo "gateway=FAILED after 60s"
exit 1

