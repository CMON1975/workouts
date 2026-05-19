#!/usr/bin/env bash
# Install / refresh the workouts Apache vhost on the droplet.
#
# Usage:  sudo bash deploy/install-apache.sh <tailscale-ip>
#
# Substitutes __TAILSCALE_IP__ into deploy/apache-workouts.conf, drops the
# result at /etc/apache2/sites-available/workouts.cmon1975.com.conf,
# enables the site + required modules, configtests, and reloads Apache.
#
# Re-run safely after editing the template. Does not touch the Node service.

set -euo pipefail

TAILSCALE_IP="${1:-}"

if [[ -z "$TAILSCALE_IP" ]]; then
    echo "usage: $0 <tailscale-ip>" >&2
    exit 2
fi

if [[ $EUID -ne 0 ]]; then
    echo "error: run as root (use sudo)" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v tailscale >/dev/null 2>&1; then
    echo "error: tailscale not installed. Install and join the tailnet first." >&2
    exit 1
fi
if ! tailscale ip -4 | grep -qx "$TAILSCALE_IP"; then
    echo "error: $TAILSCALE_IP is not one of this host's tailscale IPs:" >&2
    tailscale ip -4 >&2
    exit 1
fi

SITE_CONF=/etc/apache2/sites-available/workouts.cmon1975.com.conf
echo "==> Writing $SITE_CONF"
sed "s|__TAILSCALE_IP__|$TAILSCALE_IP|g" \
    "$SCRIPT_DIR/apache-workouts.conf" >"$SITE_CONF"

echo "==> Enabling modules + site"
a2enmod ssl rewrite headers proxy proxy_http
a2ensite workouts.cmon1975.com

# Disable any stale public-facing vhost if it's still enabled under the
# old filename. Harmless no-op if it was never created.
a2dissite workouts 2>/dev/null || true

echo "==> apache2ctl configtest"
apache2ctl configtest

echo "==> Reloading apache2"
systemctl reload apache2

echo "OK: vhost installed for $TAILSCALE_IP"
