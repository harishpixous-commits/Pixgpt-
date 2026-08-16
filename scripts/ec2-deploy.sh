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

systemctl restart pixgpt
sleep 3

echo "services: omniroute=$(systemctl is-active omniroute) pixgpt=$(systemctl is-active pixgpt)"
curl -fsS -o /dev/null -w "http=%{http_code}\n" http://localhost/ || echo "http=failed"
HEALTH=$(curl -fsS --max-time 10 http://localhost/api/health || true)
echo "health=$HEALTH"
if echo "$HEALTH" | grep -q '"reachable":true'; then
  echo "gateway=ok"
else
  echo "gateway=FAILED"
  exit 1
fi
echo "=== deploy done $(date -u) ==="
