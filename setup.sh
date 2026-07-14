#!/usr/bin/env bash
set -euo pipefail

# ─── SiteClone Installer ────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/harrywang/siteclone/main/setup.sh | bash
#
# Or clone manually:
#   git clone https://github.com/harrywang/siteclone.git && cd siteclone && ./setup.sh
# ──────────────────────────────────────────────────────────────────────

REPO="https://github.com/harrywang/siteclone.git"
DIR="siteclone"
PORT="${SITECLONE_PORT:-3000}"

info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m==>\033[0m %s\n" "$1"; }
error() { printf "\033[1;31m==>\033[0m %s\n" "$1" >&2; }

# ─── Prerequisites ───────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || { error "Node.js is required. Install it from https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { error "npm is required. It ships with Node.js."; exit 1; }

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js 20+ is required (found v$(node -v)). Please upgrade."
  exit 1
fi

# ─── Clone (skip if already inside the repo) ────────────────────────

if [ ! -f "package.json" ] || ! grep -q '"siteclone"' package.json 2>/dev/null; then
  if [ -d "$DIR" ]; then
    info "Directory '$DIR' already exists — pulling latest..."
    cd "$DIR"
    git pull --ff-only
  else
    info "Cloning SiteClone..."
    git clone "$REPO" "$DIR"
    cd "$DIR"
  fi
fi

# ─── Install ─────────────────────────────────────────────────────────

info "Installing dependencies..."
npm install

# ─── Build ───────────────────────────────────────────────────────────

info "Building production bundle..."
npm run build

# ─── Done ────────────────────────────────────────────────────────────

ok "SiteClone is ready!"
echo ""
echo "  Run as web app:"
echo "    npm start              # then open http://localhost:${PORT}"
echo ""
echo "  Run as desktop app:"
echo "    npm run electron:dev"
echo ""
echo "  Build a Mac .dmg:"
echo "    npm run electron:build:mac"
echo ""
echo "  Build a Windows .exe:"
echo "    npm run electron:build:win"
echo ""
echo "  For dynamic mode (JS-rendered sites), install Chromium once:"
echo "    npx playwright install chromium"
echo ""
