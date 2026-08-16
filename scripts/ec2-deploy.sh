#!/bin/bash
# Runs ON the EC2 instance (invoked by GitHub Actions via SSM Run Command).
# Pulls the latest main, rebuilds, restarts the service, and verifies.
set -euo pipefail

cd /opt/pixgpt

echo "=== deploy $(date -u) ==="
git fetch origin main
git checkout --force FETCH_HEAD
echo "HEAD=$(git rev-parse --short HEAD)"

npm ci --no-audit --no-fund

# Demo build: fully functional without a private AI gateway.
# Swap for `npm run build` + a server-side .env when a gateway is configured.
VITE_PIXGPT_DEMO=1 npm run build

systemctl restart pixgpt
sleep 3

echo "service=$(systemctl is-active pixgpt)"
curl -fsS -o /dev/null -w "http=%{http_code}\n" http://localhost/ || echo "http=failed"
echo "=== deploy done $(date -u) ==="
