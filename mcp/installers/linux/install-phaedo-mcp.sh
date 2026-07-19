#!/usr/bin/env bash
# Run this to install Phaedo into your AI apps (Claude Desktop, Cursor, Claude
# Code) and pair with your phone:  bash install-phaedo-mcp.sh
# Safe to run again any time — it updates, never clobbers.
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$HERE/../.." && pwd)"
cd "$MCP_DIR"

echo "Phaedo MCP installer"
echo "Folder: $MCP_DIR"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js isn't installed. Install it from https://nodejs.org or your package"
  echo "  manager (e.g. 'sudo apt install nodejs npm'), then run this again."
  exit 1
fi
echo "Using node: $(node --version) at $(command -v node)"
echo

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one time)…"
  npm install --omit=dev
  echo
fi

node install.mjs --pair

echo
echo "Done. If a client was already open, restart it so it picks up Phaedo."
