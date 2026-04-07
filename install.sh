#!/bin/bash
# PixelPrint Kiosk One-Command Installation Script
# Usage: sudo bash install.sh NIT_CALICUT_MILMA
# ─────────────────────────────────────────────────────────────────────────────

set -e   # exit on any error

KIOSK_ID="${1}"
BACKEND_URL="${2:-https://printing-pixel-1.onrender.com}"
AGENT_SECRET="${3:-pixelprint-agent-2026}"
AGENT_DIR="/opt/pixelprint-agent"
CONFIG_DIR="/etc/pixelprint"
KIOSK_APP_URL="https://kiosk-app-beta.vercel.app"   # update this to your Vercel URL

if [ -z "$KIOSK_ID" ]; then
  echo "❌ Usage: sudo bash install.sh <KIOSK_ID> [BACKEND_URL] [AGENT_SECRET]"
  echo "   Example: sudo bash install.sh NIT_CALICUT_MILMA"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   PixelPrint Kiosk Installation — ${KIOSK_ID}"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. System dependencies ─────────────────────────────────────────────────
echo "📦 Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  nodejs \
  npm \
  git \
  ghostscript \
  imagemagick \
  chromium-browser \
  cups \
  curl

# Install PM2 globally
npm install -g pm2 --quiet

echo "✅ System dependencies installed"

# ── 2. Clone / update the print-agent ─────────────────────────────────────
echo ""
echo "📥 Setting up print agent..."

if [ -d "$AGENT_DIR" ]; then
  echo "   Agent directory exists — pulling latest..."
  cd "$AGENT_DIR" && git pull
else
  # IMPORTANT: Replace with your actual GitHub repo URL
  git clone https://github.com/YOUR_ORG/pixelprint-agent "$AGENT_DIR" 2>/dev/null || {
    echo "   Git repo not set up yet — copying local files..."
    mkdir -p "$AGENT_DIR"
    cp -r /tmp/pixelprint-agent/. "$AGENT_DIR/" 2>/dev/null || true
  }
fi

cd "$AGENT_DIR"
npm install --quiet

echo "✅ Print agent installed at $AGENT_DIR"

# ── 3. Write kiosk config ────────────────────────────────────────────────
echo ""
echo "⚙️  Writing kiosk config..."

mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "kioskId": "${KIOSK_ID}",
  "backendUrl": "${BACKEND_URL}",
  "secret": "${AGENT_SECRET}"
}
EOF

chmod 600 "$CONFIG_DIR/config.json"
echo "✅ Config written to $CONFIG_DIR/config.json"

# ── 4. Start agent with PM2 ────────────────────────────────────────────────
echo ""
echo "🚀 Starting print agent with PM2..."

pm2 delete pixelprint-agent 2>/dev/null || true
pm2 start "$AGENT_DIR/agent.js" --name pixelprint-agent \
  --env "CONFIG_PATH=$CONFIG_DIR/config.json" \
  --restart-delay 3000 \
  --max-restarts 10

pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

echo "✅ Print agent running (PM2)"

# ── 5. Set up Chromium kiosk autostart ────────────────────────────────────
echo ""
echo "🌐 Setting up Chromium kiosk autostart..."

cat > /usr/local/bin/start-pixelprint-kiosk.sh <<EOF
#!/bin/bash
KIOSK_ID=\$(python3 -c "import sys,json; print(json.load(open('/etc/pixelprint/config.json'))['kioskId'])")
exec chromium-browser \\
  --kiosk \\
  --app="${KIOSK_APP_URL}?kiosk=\${KIOSK_ID}" \\
  --no-sandbox \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-restore-session-state \\
  --disable-translate \\
  --noerrdialogs \\
  --start-maximized \\
  --check-for-update-interval=31536000
EOF

chmod +x /usr/local/bin/start-pixelprint-kiosk.sh

# Create XDG autostart entry (works for most desktop environments)
mkdir -p /etc/xdg/autostart
cat > /etc/xdg/autostart/pixelprint-kiosk.desktop <<EOF
[Desktop Entry]
Type=Application
Name=PixelPrint Kiosk
Exec=/usr/local/bin/start-pixelprint-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

echo "✅ Chromium autostart configured"

# ── 6. Install Tailscale (remote management) ──────────────────────────────
echo ""
echo "🔐 Installing Tailscale for remote access..."
curl -fsSL https://tailscale.com/install.sh | sh 2>/dev/null || echo "   Tailscale install failed — install manually"
echo "⚠️  Run 'sudo tailscale up' to authorize this machine in your Tailscale account"

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   ✅ Installation Complete!                              ║"
echo "╟──────────────────────────────────────────────────────────╢"
echo "║   Kiosk ID : ${KIOSK_ID}"
echo "║   Backend  : ${BACKEND_URL}"
echo "║   Agent    : pm2 status pixelprint-agent"
echo "║   Logs     : pm2 logs pixelprint-agent"
echo "║   Reboot and the kiosk will auto-start."
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
