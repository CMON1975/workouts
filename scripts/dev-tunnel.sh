#!/usr/bin/env bash
# Local dev server + ngrok tunnel for iPhone testing.
# Runs the test suite first; if green, starts Fastify on $PORT and
# exposes it via ngrok. Prints both URLs. Ctrl-C tears everything down.
set -euo pipefail

PORT="${PORT:-8787}"
DEV_LOG=/tmp/workouts-dev.log
NGROK_LOG=/tmp/workouts-ngrok.log

cleanup() {
  echo
  echo "stopping..."
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${NGROK_PID:-}"  ]] && kill "$NGROK_PID"  2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "→ running unit tests..."
npm test --silent

echo
echo "→ starting dev server on :$PORT (log: $DEV_LOG)"
npm run dev >"$DEV_LOG" 2>&1 &
SERVER_PID=$!

# Wait until the server answers on the port.
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 0.2
done

echo "→ starting ngrok (log: $NGROK_LOG)"
ngrok http "$PORT" --log=stdout >"$NGROK_LOG" 2>&1 &
NGROK_PID=$!

# Poll ngrok's local API for the public URL.
PUBLIC_URL=""
for _ in $(seq 1 50); do
  PUBLIC_URL=$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | grep -o 'https://[^"]*\.ngrok[-a-z.]*' | head -n1 || true)
  [[ -n "$PUBLIC_URL" ]] && break
  sleep 0.2
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "ngrok did not expose a tunnel. Check $NGROK_LOG"
  cleanup
fi

cat <<EOF

  desktop: http://127.0.0.1:$PORT
  iphone:  $PUBLIC_URL
  ngrok ui: http://127.0.0.1:4040

  logs:    tail -f $DEV_LOG $NGROK_LOG
  ctrl-c to stop both.
EOF

wait
