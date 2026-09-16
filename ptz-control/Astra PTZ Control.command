#!/bin/bash
# Double-click launcher for Astra PTZ Control (macOS).
# Starts the server and opens the dashboard in your default browser.

cd "$(dirname "$0")"

# Homebrew installs (node/ffmpeg) live here on Apple Silicon; make sure
# double-clicked Terminal sessions can find them.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed. Install it first:"
  echo "  brew install node"
  echo "or download it from https://nodejs.org"
  echo ""
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Note: ffmpeg not found - camera controls will work but video"
  echo "previews will be blank. To enable video:  brew install ffmpeg"
  echo ""
fi

PORT="${PORT:-8300}"

# Open the dashboard once the server has had a moment to start.
( sleep 1.5; open "http://localhost:$PORT" ) &

echo "Starting Astra PTZ Control... (leave this window open; press Ctrl+C to quit)"
exec node server.js --port "$PORT"
