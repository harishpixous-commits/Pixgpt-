#!/bin/bash
# PixGPT EC2 bootstrap (Amazon Linux 2023 user-data).
# Builds the app in demo mode (VITE_PIXGPT_DEMO=1) so the live site is fully
# functional without a private AI gateway. Swap the build line for a real
# gateway-backed deploy once a server-side gateway is configured.
exec > /var/log/pixgpt-bootstrap.log 2>&1
set -e

echo "=== bootstrap start $(date -u) ==="

# t3.micro has 1 GiB RAM and tsc/vite can get tight; a swapfile keeps the
# build from being OOM-killed.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null 2>&1
  swapon /swapfile
fi

# git is not present on a fresh AL2023 image — the clone below would fail
# without it, and with `set -e` that aborts the whole bootstrap.
dnf install -y git >/dev/null 2>&1 || true

# Node 22 (falls back to the default nodejs package if 22 is unavailable)
if dnf install -y nodejs22 >/dev/null 2>&1; then
  echo "installed nodejs22"
elif dnf install -y nodejs >/dev/null 2>&1; then
  echo "installed default nodejs"
else
  echo "FAILED: could not install nodejs" >&2
  exit 1
fi

node --version
npm --version

git clone --depth 1 https://github.com/harishpixous-commits/Pixgpt-.git /opt/pixgpt
cd /opt/pixgpt

npm ci --no-audit --no-fund
VITE_PIXGPT_DEMO=1 npm run build

cat > /etc/systemd/system/pixgpt.service <<'EOF'
[Unit]
Description=PixGPT web app (API + static)
After=network.target

[Service]
WorkingDirectory=/opt/pixgpt
Environment=PORT=80
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pixgpt
systemctl start pixgpt

echo "=== bootstrap done $(date -u) ==="
