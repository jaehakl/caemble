#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/caemble}
API_DIR=${API_DIR:-$APP_DIR/app/api}
UI_ARTIFACT=${UI_ARTIFACT:-$APP_DIR/deployment/caemble-ui.tar.gz}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}
NGINX_CONFIG_SOURCE=${NGINX_CONFIG_SOURCE:-$APP_DIR/deployment/app.conf}
NGINX_CONFIG_TARGET=${NGINX_CONFIG_TARGET:-/etc/nginx/sites-available/caemble.conf}

echo "[1/6] Pull latest code and UI artifact"
cd "$APP_DIR"
git pull --ff-only

echo "[2/6] Install API dependencies"
cd "$API_DIR"
poetry install --only main

api_service_installed=false
if sudo systemctl cat "$API_SERVICE" >/dev/null 2>&1; then
    api_service_installed=true
    sudo systemctl stop "$API_SERVICE"
fi

echo "[3/6] Recreate or migrate the application schema"
if [[ "${RESET_API_SCHEMA:-0}" == "1" ]]; then
    RESET_API_SCHEMA=1 poetry run python reset_schema.py
else
    poetry run alembic upgrade head
fi

echo "[4/6] Publish the static release"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_DIR" rev-parse --short HEAD)"
releases_dir="$WEB_ROOT/releases"
release_dir="$releases_dir/$release_name"
next_link="$WEB_ROOT/.current-$release_name"

sudo mkdir -p "$release_dir"
sudo tar --no-same-owner -xzf "$UI_ARTIFACT" -C "$release_dir"
sudo chown -R root:www-data "$release_dir"
sudo find "$release_dir" -type d -exec chmod 755 {} \;
sudo find "$release_dir" -type f -exec chmod 644 {} \;
sudo ln -s "$release_dir" "$next_link"
sudo mv -Tf "$next_link" "$WEB_ROOT/current"

echo "[5/6] Start API service"
if [[ "$api_service_installed" == true ]]; then
    sudo systemctl restart "$API_SERVICE"
fi

echo "[6/6] Install and reload Nginx"
sudo install -m 644 "$NGINX_CONFIG_SOURCE" "$NGINX_CONFIG_TARGET"
sudo systemctl reload nginx

echo "Deployment complete: $release_dir"
