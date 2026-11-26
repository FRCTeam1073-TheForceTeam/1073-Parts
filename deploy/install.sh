#!/usr/bin/env bash
# Installs or updates the 1073 Parts service on this server.
#
#   sudo ./deploy/install.sh
#
# Runs the step scripts in deploy/script/ in order. Each one does one job and can also be run on its own.
#
# Idempotent: the first run creates everything. Later runs change only what is out of date, and print
# nothing when nothing is. Data and settings are never overwritten.
#
# Optional environment variables:
#   SETUP_CODE   value for a new env file, so the script does not prompt for it
#   NODE_BIN     node binary to use (default: the node found on PATH)

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prerequisites: root, required commands, Node version
"$DEPLOY_DIR/script/check.sh"
# Service user and data folder
"$DEPLOY_DIR/script/user.sh"
# Copy code to /opt/1073-parts and install production dependencies
"$DEPLOY_DIR/script/code.sh"
# Create /etc/1073-parts/parts.env (only if it does not exist)
"$DEPLOY_DIR/script/settings.sh"
# Install the systemd unit, enable it, and restart it
"$DEPLOY_DIR/script/service.sh"
# Check that the service answers on its port
"$DEPLOY_DIR/script/verify.sh"
# Install the Apache site that serves the app (only after the app answers)
"$DEPLOY_DIR/script/apache.sh"
