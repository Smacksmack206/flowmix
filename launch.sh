#!/usr/bin/env bash
# FlowMix launcher — starts the server if needed, then opens the app.
cd "$(dirname "$0")"

if ! curl -s --max-time 2 http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
  setsid nohup python3 server.py > /tmp/flowmix.log 2>&1 < /dev/null &
  for _ in $(seq 1 24); do
    sleep 0.5
    curl -s --max-time 2 http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break
  done
fi

xdg-open http://127.0.0.1:8080
