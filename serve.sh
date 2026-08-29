#!/usr/bin/env bash
# Tailnet-visible dev runner: binds to this machine's Tailscale IPv4 so the
# app can be driven from another tailnet device (windows-11 / iPhone) the same
# way it's reached in prod. HOST set here overrides .env (Node's --env-file
# never overrides real environment variables).
set -euo pipefail
cd "$(dirname "$0")"
HOST="$(tailscale ip -4)"
echo "serving on http://${HOST}:${PORT:-8787}/"
HOST="$HOST" exec node --env-file=.env --watch server/index.js
