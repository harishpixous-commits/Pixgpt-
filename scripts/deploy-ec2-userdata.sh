#!/bin/bash
# PixGPT EC2 bootstrap (Amazon Linux 2023 user-data).
# Full production stack:
#   1. OmniRoute (the AI gateway) — config pulled from the private S3 bucket
#   2. PixGPT built WITHOUT demo mode so it talks to the real gateway
# The config bucket holds ~/.omniroute contents (storage.sqlite + .env) that
# the instance role (pixgpt-ssm-role) is allowed to read.
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

# ---- OmniRoute: the AI gateway PixGPT talks to on 127.0.0.1:20128 ----
npm install -g omniroute@3.8.49
BUCKET=pixgpt-omniroute-config-276699357742
mkdir -p /root/.omniroute
aws s3 cp s3://$BUCKET/omniroute/storage.sqlite /root/.omniroute/storage.sqlite
aws s3 cp s3://$BUCKET/omniroute/.env /root/.omniroute/.env
ls -la /root/.omniroute

cat > /etc/systemd/system/omniroute.service <<'EOF'
[Unit]
Description=OmniRoute AI gateway
After=network.target

[Service]
WorkingDirectory=/root
ExecStart=/usr/lib/nodejs22/bin/omniroute
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable omniroute
systemctl start omniroute

# ---- PixGPT ----
git clone --depth 1 https://github.com/harishpixous-commits/Pixgpt-.git /opt/pixgpt
cd /opt/pixgpt

npm ci --no-audit --no-fund
npm run build

# Production gateway config. Non-secret values mirror the local .env; the
# base URL default (http://127.0.0.1:20128/v1) is what OmniRoute listens on.
#
# The vision alias points at OmniRoute's best-vision route rather than bare
# `auto`: `auto` picks premium pools (aug/tllm) that need credentials this
# deployment does not have, so it hangs for ~60s, while auto/best-vision
# resolves to the working free pool instantly. VISION_FALLBACK_MODELS stays
# empty on purpose — falling back from a vision request to a text-only model
# turns "describe this image" into a request the route cannot satisfy.
cat > /opt/pixgpt/.env <<'EOF'
PORT=80
OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
OMNIROUTE_TIMEOUT_MS=60000
OMNIROUTE_HEALTH_PATH=/api/health/ping
OMNIROUTE_MODEL_VISION=auto/best-vision
OMNIROUTE_FALLBACK_MODELS=auto/fast
LOG_LEVEL=info
PIXGPT_VISION_ALIASES=pixgpt-vision
WEB_SEARCH_PROVIDER=wikipedia
EOF

cat > /etc/systemd/system/pixgpt.service <<'EOF'
[Unit]
Description=PixGPT web app (API + static)
After=network.target omniroute.service

[Service]
WorkingDirectory=/opt/pixgpt
EnvironmentFile=/opt/pixgpt/.env
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pixgpt
systemctl start pixgpt

# If the operator added a Gemini key (gemini.env in the config bucket), ensure
# the provider exists in OmniRoute and merge its routing env into the app env.
# Idempotent; a no-op when no key is configured.
bash /opt/pixgpt/scripts/ensure-gemini.sh || true
systemctl restart pixgpt

echo "=== bootstrap done $(date -u) ==="
