#!/usr/bin/env bash
# Copies the application code to APP_DIR and installs production dependencies, only when they changed.
# Prints nothing when already up to date. When anything changes, it leaves RESTART_FLAG for service.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_root
require_commands rsync sha256sum
resolve_node
# mkdir, not install -d: install -d resets the mode on every run, which rsync then reports as a change.
mkdir -p "$APP_DIR" "$CONF_DIR"

# Copy the code. With -i, rsync lists only the items it changed (or deleted), so empty output means nothing changed.
changes="$(rsync -ai --delete --chown=root:root \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='data-*/' \
  --exclude='e2e/' \
  --exclude='test/' \
  --exclude='deploy/' \
  --exclude='*.tar' \
  --exclude='playwright*.config.js' \
  --exclude='.env' \
  --exclude='.env.*' \
  "$SRC_DIR"/ "$APP_DIR"/)"
if [[ -n "$changes" ]]; then
  touch "$RESTART_FLAG"
fi

# Install dependencies only when package.json, the lock file or the Node version changed.
# The stamp lives inside node_modules, which npm ci replaces, so it is always written after a fresh install.
deps_stamp="$APP_DIR/node_modules/.parts-deps-stamp"
deps_now="$(cat "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" | sha256sum | cut -d' ' -f1) $("$NODE_BIN" -v)"
if [[ ! -f "$deps_stamp" || "$(cat "$deps_stamp")" != "$deps_now" ]]; then
  (cd "$APP_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --no-audit --no-fund >/dev/null)
  printf '%s\n' "$deps_now" > "$deps_stamp"
  touch "$RESTART_FLAG"
fi
