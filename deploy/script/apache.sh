#!/usr/bin/env bash
# Installs the Apache site that serves the app (deploy/apache-site.conf), enables the modules it needs,
# and reloads Apache only when something changed. Prints nothing when already up to date.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

APACHE_DIR=/etc/apache2
SITE_NAME=parts
SITE_SRC="$DEPLOY_DIR/apache-site.conf"
SITE_AVAILABLE="$APACHE_DIR/sites-available/$SITE_NAME.conf"
SITE_ENABLED="$APACHE_DIR/sites-enabled/$SITE_NAME.conf"
APACHE_MODULES="proxy proxy_http headers rewrite ssl"

require_root
require_commands apache2ctl a2enmod a2ensite systemctl

changed=0

for mod in $APACHE_MODULES; do
  if [[ ! -e "$APACHE_DIR/mods-enabled/$mod.load" ]]; then
    echo "Enabling Apache module: $mod"
    a2enmod -q "$mod" >/dev/null
    changed=1
  fi
done

if ! cmp -s "$SITE_SRC" "$SITE_AVAILABLE"; then
  echo "Updating Apache site: $SITE_NAME"
  install -o root -g root -m 0644 "$SITE_SRC" "$SITE_AVAILABLE"
  changed=1
fi

if [[ ! -e "$SITE_ENABLED" && ! -L "$SITE_ENABLED" ]]; then
  echo "Enabling Apache site: $SITE_NAME"
  a2ensite -q "$SITE_NAME" >/dev/null
  changed=1
fi

if (( changed )); then
  if ! apache2ctl configtest >/dev/null 2>&1; then
    apache2ctl configtest || true
    die "Apache config test failed; not reloading. Fix deploy/apache-site.conf and rerun"
  fi
  echo "Reloading Apache"
  systemctl reload apache2
fi
