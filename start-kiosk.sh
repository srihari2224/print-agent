#!/bin/bash
# Starts Chromium in kiosk mode with the correct kioskId from config.
# This is called by the systemd/XDG autostart entry.

CONFIG_FILE="/etc/pixelprint/config.json"
KIOSK_APP_URL="https://kiosk-app-beta.vercel.app"

KIOSK_ID=$(python3 -c "import sys,json; print(json.load(open('${CONFIG_FILE}'))['kioskId'])" 2>/dev/null)

if [ -z "$KIOSK_ID" ]; then
  echo "❌ Could not read kioskId from ${CONFIG_FILE}"
  exit 1
fi

echo "🖥️  Starting kiosk: ${KIOSK_ID}"
echo "🌐  URL: ${KIOSK_APP_URL}?kiosk=${KIOSK_ID}"

# Disable screen sleep / blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

exec chromium-browser \
  --kiosk \
  --app="${KIOSK_APP_URL}?kiosk=${KIOSK_ID}" \
  --no-sandbox \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --disable-translate \
  --noerrdialogs \
  --start-maximized \
  --check-for-update-interval=31536000 \
  --disable-pinch \
  --overscroll-history-navigation=0
