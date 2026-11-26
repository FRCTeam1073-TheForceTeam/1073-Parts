#!/usr/bin/env bash
# Installs the systemd unit with this machine's node and app paths, enables it, and restarts it only when
# the unit or the code changed, or the service is not running. Prints nothing when already up to date.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_root
require_commands systemctl mktemp
resolve_node

rendered_unit="$(mktemp)"
trap 'rm -f "$rendered_unit"' EXIT
sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" "$DEPLOY_DIR/parts.service" > "$rendered_unit"

unit_changed=0
if ! cmp -s "$rendered_unit" "$UNIT_FILE"; then
  install -o root -g root -m 0644 "$rendered_unit" "$UNIT_FILE"
  systemctl daemon-reload
  unit_changed=1
fi

if ! systemctl is-enabled -q "$SERVICE"; then
  systemctl enable "$SERVICE" >/dev/null
fi

reasons=()
if (( unit_changed )); then reasons+=("unit file changed"); fi
if [[ -f "$RESTART_FLAG" ]]; then reasons+=("code or dependencies changed"); fi
if ! systemctl is-active -q "$SERVICE"; then reasons+=("service was not running"); fi

if (( ${#reasons[@]} )); then
  printf -v reason_text '%s, ' "${reasons[@]}"
  echo "Restarting $SERVICE: ${reason_text%, }"
  systemctl restart "$SERVICE"
  rm -f "$RESTART_FLAG"
fi
