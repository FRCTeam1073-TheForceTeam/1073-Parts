#!/usr/bin/env bash
# Checks prerequisites: root, required commands, Node version and location. Prints nothing when they pass.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_root
require_commands systemctl rsync curl
resolve_node
