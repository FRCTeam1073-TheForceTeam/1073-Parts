#!/usr/bin/env bash
# Checks that the service answers on the port from the settings file. Prints nothing when it does.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_commands systemctl curl

port="$DEFAULT_PORT"
if [[ -f "$ENV_FILE" ]]; then
  port="$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
  port="${port:-$DEFAULT_PORT}"
fi

for _ in $(seq 1 20); do
  if curl -fs -o /dev/null "http://127.0.0.1:$port/api/auth"; then
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --lines=5 status "$SERVICE" || true
die "service did not answer on 127.0.0.1:$port. See: journalctl -u $SERVICE -n 50"
