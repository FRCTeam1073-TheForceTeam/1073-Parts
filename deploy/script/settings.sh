#!/usr/bin/env bash
# Creates the settings file if it does not exist. An existing file is never changed. Prints nothing when it exists.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_root
install -d -o root -g root -m 0755 "$CONF_DIR"

if [[ -f "$ENV_FILE" ]]; then
  exit 0
fi

setup_code="${SETUP_CODE:-}"
if [[ -z "$setup_code" ]]; then
  [[ -t 0 ]] || die "no $ENV_FILE yet and no terminal to ask for SETUP_CODE. Rerun with SETUP_CODE=... set"
  read -r -s -p "Choose SETUP_CODE (needed to create the first admin account): " setup_code
  echo
  [[ -n "$setup_code" ]] || die "SETUP_CODE cannot be empty"
fi

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
cat > "$tmp_env" <<EOF
# Created by deploy/script/settings.sh. See deploy/parts.env.example for what each setting does.
PORT=$DEFAULT_PORT
DATA_DIR=$DATA_DIR
SETUP_CODE=$setup_code
TRUST_PROXY=1
EOF
install -o root -g "$APP_USER" -m 0640 "$tmp_env" "$ENV_FILE"
