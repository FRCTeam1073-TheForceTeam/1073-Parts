#!/usr/bin/env bash
# Shared settings and helpers for the deploy/ scripts. Sourced by each script, not run directly.
# Scripts are idempotent: they print nothing and change nothing when the thing they manage is already up to date.

APP_USER=parts
APP_DIR=/opt/1073-parts
DATA_DIR=/var/lib/1073-parts
CONF_DIR=/etc/1073-parts
ENV_FILE="$CONF_DIR/parts.env"
RESTART_FLAG="$CONF_DIR/restart-needed"
UNIT_FILE=/etc/systemd/system/parts.service
SERVICE=parts
DEFAULT_PORT=8090
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$(dirname "$DEPLOY_DIR")"

die() { echo "error: $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "run as root, e.g. sudo $0"
}

require_commands() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null || die "$cmd is required but not installed"
  done
}

# Finds node and npm and checks the version. Sets NODE_BIN (the path as found, not resolved, so
# changing the node symlink later does not require reinstalling), NODE_REAL (resolved, for checks),
# NPM_BIN, NODE_MAJOR and NODE_MINOR.
resolve_node() {
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found. Install Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer, or set NODE_BIN"

  NODE_REAL="$(readlink -f "$NODE_BIN")"
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  [[ -x "$NPM_BIN" ]] || die "npm not found next to $NODE_BIN"

  read -r NODE_MAJOR NODE_MINOR < <("$NODE_BIN" -p 'process.versions.node.split(".").slice(0,2).join(" ")')
  if (( NODE_MAJOR < MIN_NODE_MAJOR || (NODE_MAJOR == MIN_NODE_MAJOR && NODE_MINOR < MIN_NODE_MINOR) )); then
    die "Node $NODE_MAJOR.$NODE_MINOR found; $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer is required"
  fi
  case "$NODE_REAL" in
    /home/*|/root/*)
      die "$NODE_REAL is inside a home folder, which the service cannot read (ProtectHome). Install Node system-wide or set NODE_BIN to a system path"
      ;;
  esac
}
