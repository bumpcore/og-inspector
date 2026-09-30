#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
out="dist/og-inspector-${version}.zip"
rm -f "$out"
zip -q -r "$out" manifest.json popup.html popup.css popup.js icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png
echo "$out"
