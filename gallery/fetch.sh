#!/usr/bin/env bash
# Fetch the two producers' own screens into gallery/.vendor/. The banner is drawn from these,
# so it carries official artwork and no operator screenshot.
# Needs: python3 venv with pillow and cairosvg. Not committed: gallery/.vendor is gitignored.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .vendor
get() { curl -sfL -o ".vendor/$1" "$2" || { echo "fetch failed: $2" >&2; exit 1; }; }
get pi-screen.png        https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/images/interactive-mode.png
get opencode-splash.png  https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/assets/lander/screenshot-splash.png
get opencode-screen.png  https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/assets/lander/screenshot.png
echo "vendor ready: $(ls .vendor | tr '\n' ' ')"
