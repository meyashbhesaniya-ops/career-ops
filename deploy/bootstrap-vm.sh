#!/usr/bin/env bash
# deploy/bootstrap-vm.sh — Oracle E2.1.Micro VM bootstrap
#
# Run once on each Oracle VM after SSH access is established:
#   ssh ubuntu@89.168.115.96 'bash -s' < deploy/bootstrap-vm.sh
#   ssh ubuntu@130.162.209.192 'bash -s' < deploy/bootstrap-vm.sh
#
# After running: copy .env files to each VM via scp, then start pm2 processes.

set -euo pipefail

REPO="https://github.com/santifer/career-ops.git"
APP_DIR="$HOME/career-ops"
NODE_VERSION="20"

echo "==> [1/8] System update"
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

echo "==> [2/8] Install dependencies"
sudo apt-get install -y -qq \
  curl git unzip build-essential ca-certificates gnupg \
  chromium-browser chromium-chromedriver \
  libatk1.0-0 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2

echo "==> [3/8] Install Node.js ${NODE_VERSION}"
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> [4/8] Install pm2 globally"
sudo npm install -g pm2

echo "==> [5/8] Install Caddy"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq && sudo apt-get install -y caddy

echo "==> [6/8] Clone/update repo"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull --rebase
else
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> [7/8] Install npm dependencies"
npm ci --omit=dev
cd bridge && npm ci --omit=dev && cd ..

echo "==> [8/8] Install Playwright Chromium"
npx playwright install chromium --with-deps 2>/dev/null || true

echo ""
echo "============================================================"
echo "  Bootstrap complete for $(hostname)"
echo "============================================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Copy your .env file to this VM:"
echo "   scp .env ubuntu@$(curl -s ifconfig.me):~/career-ops/.env"
echo ""
echo "2. Generate VAULT_KEY (run once, add to .env):"
echo "   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
echo ""
echo "3. Start processes with pm2:"
echo ""
echo "   ON MICRO #0 (89.168.115.96) — Orchestrator + Bot + Scout + Evaluator:"
echo "   cd ~/career-ops"
echo "   pm2 start agents/orchestrator.mjs --name orchestrator --interpreter node"
echo "   pm2 start agents/telegram-bot.mjs --name telegram-bot --interpreter node"
echo "   pm2 start agents/scout.mjs --name scout --interpreter node"
echo "   pm2 start agents/evaluator.mjs --name evaluator --interpreter node"
echo "   pm2 start agents/oci-capacity-watch.mjs --name oci-watch --interpreter node"
echo "   pm2 save && pm2 startup"
echo ""
echo "   ON MICRO #1 (130.162.209.192) — Tailor:"
echo "   cd ~/career-ops"
echo "   pm2 start agents/tailor.mjs --name tailor --interpreter node"
echo "   pm2 save && pm2 startup"
echo ""
echo "4. Open Oracle firewall (Security List ingress rules):"
echo "   Port 9000 TCP (orchestrator) — from GitHub Actions IPs only"
echo "   Port 443 TCP (Caddy HTTPS) — from 0.0.0.0/0"
echo "   Port 80 TCP (Caddy redirect) — from 0.0.0.0/0"
echo ""
echo "5. Set GitHub Actions secrets:"
echo "   SUPABASE_URL, SUPABASE_SERVICE_KEY, VAULT_KEY"
echo "   ORCHESTRATOR_URL, ORCHESTRATOR_TOKEN"
echo "   GROQ_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY"
echo "   TELEGRAM_BOT_TOKEN (DO NOT COMMIT)"
echo "   GH_WEBHOOK_SECRET, GITHUB_PAT, SUPABASE_DB_URL"
echo ""
echo "6. Run DB migrations in Supabase SQL editor:"
echo "   Contents of db/migrations/001_schema.sql"
echo ""
echo "7. Verify all agents are up: pm2 status"
echo ""
