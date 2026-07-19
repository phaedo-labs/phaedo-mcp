#!/bin/bash
# Double-click this file to install Phaedo into your AI apps (Claude Desktop,
# Cursor, Claude Code) and pair with your phone. It opens in Terminal and runs
# the installer for you. Safe to run again any time — it updates, never clobbers.
set -e

# Resolve the mcp/ folder relative to this script (installers/macos/ -> mcp/).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$HERE/../.." && pwd)"
cd "$MCP_DIR"

echo "Phaedo MCP installer"
echo "Folder: $MCP_DIR"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js isn't installed."
  echo "  Install it from https://nodejs.org (the LTS button), then double-click this again."
  echo
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
echo "Using node: $(node --version) at $(command -v node)"
echo

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one time)…"
  npm install --omit=dev
  echo
fi

# Configure every detected client, then run the one-time phone pairing.
node install.mjs --pair

echo
echo "Done. If a client was already open, restart it so it picks up Phaedo."
read -n 1 -s -r -p "Press any key to close."
