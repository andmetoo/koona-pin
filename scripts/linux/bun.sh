#!/usr/bin/env bash
# Bun of .bun-version into /opt/bun, as root, at build time of every CI image (scripts/linux/images/*.Dockerfile,
# scripts/linux/images.mjs): the jobs of .github/workflows/linux.yml install nothing. Also on PATH as `node`:
# the project has no Node of its own (Р-61), and scripts that call `node` get Bun.
set -euo pipefail
cd "$(dirname "$0")/../.."
# \r: a Windows checkout.
bun=$(tr -d 'v \r\n' < .bun-version)
zip=$(mktemp)
curl -sSfL -o "$zip" "https://github.com/oven-sh/bun/releases/download/bun-v$bun/bun-linux-x64.zip"
mkdir -p /opt/bun/bin
unzip -o -j -q "$zip" bun-linux-x64/bun -d /opt/bun/bin
rm "$zip"
ln -sf /opt/bun/bin/bun /usr/local/bin/bun
ln -sf /opt/bun/bin/bun /usr/local/bin/bunx
ln -sf /opt/bun/bin/bun /usr/local/bin/node
