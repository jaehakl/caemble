#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/caemble}
API_DIR=${API_DIR:-$APP_DIR/app/api}
UI_ARTIFACT=${UI_ARTIFACT:-$APP_DIR/deployment/caemble-ui.tar.gz}
CAE_PREPARATION_ARTIFACT=${CAE_PREPARATION_ARTIFACT:-$APP_DIR/deployment/caemble-cae-preparation.tar.gz}
CAE_PREPARATION_DIR=${CAE_PREPARATION_DIR:-$APP_DIR/app/ui/dist-cae}
CAE_NODE_EXECUTABLE=${CAE_NODE_EXECUTABLE:-node}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}
NGINX_CONFIG_SOURCE=${NGINX_CONFIG_SOURCE:-$APP_DIR/deployment/app.conf}
NGINX_CONFIG_TARGET=${NGINX_CONFIG_TARGET:-/etc/nginx/sites-available/caemble.conf}

echo "[1/6] Pull latest code and UI artifact"
cd "$APP_DIR"
git pull --ff-only

"$CAE_NODE_EXECUTABLE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) throw new Error("CAE preparation requires Node.js 22.13 or later")'
tar -tzf "$UI_ARTIFACT" >/dev/null
tar -tzf "$CAE_PREPARATION_ARTIFACT" >/dev/null

echo "[2/6] Install API dependencies"
cd "$API_DIR"
api_service_installed=false
if sudo systemctl cat "$API_SERVICE" >/dev/null 2>&1; then
    api_service_installed=true
    sudo systemctl stop "$API_SERVICE"
fi
poetry install --only main

echo "[3/6] Install CAE preparation and migrate the application schema"
mkdir -p "$CAE_PREPARATION_DIR"
tar --no-same-owner -xzf "$CAE_PREPARATION_ARTIFACT" -C "$CAE_PREPARATION_DIR"
"$CAE_NODE_EXECUTABLE" --permission --allow-fs-read="$CAE_PREPARATION_DIR" "$CAE_PREPARATION_DIR/prepare.cjs" --check
echo
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
