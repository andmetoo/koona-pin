#!/usr/bin/env bash
# Bun of .bun-version into /opt/bun, as root, for every job of .github/workflows/linux.yml (ci-setup.sh,
# ci-runtime.sh, ci-webkitgtk.sh). Also on PATH as `node`: GitHub brings its own Node for the JavaScript
# actions (artifacts), act does not, and the project has no Node of its own (Р-60).
set -euo pipefail
cd "$(dirname "$0")/../.."
# \r: a Windows checkout under act.
bun=$(tr -d 'v \r\n' < .bun-version)
zip=$(mktemp)
curl -sSfL -o "$zip" "https://github.com/oven-sh/bun/releases/download/bun-v$bun/bun-linux-x64.zip"
mkdir -p /opt/bun/bin
unzip -o -j -q "$zip" bun-linux-x64/bun -d /opt/bun/bin
rm "$zip"
ln -sf /opt/bun/bin/bun /usr/local/bin/bun
ln -sf /opt/bun/bin/bun /usr/local/bin/bunx
ln -sf /opt/bun/bin/bun /usr/local/bin/node
