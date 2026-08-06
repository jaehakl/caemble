#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/waveform}
API_DIR=${API_DIR:-$APP_DIR/apps/caemble/api}
UI_DIR=${UI_DIR:-$APP_DIR/apps/caemble/ui}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}

for command_name in git npm poetry rsync sudo; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 1
    fi
done

if [[ ! -d "$APP_DIR/.git" ]]; then
    echo "Repository not found at $APP_DIR" >&2
    exit 1
fi
if [[ ! -f "$API_DIR/.env" ]]; then
    echo "API environment file not found: $API_DIR/.env" >&2
    exit 1
fi
if [[ ! -f "$UI_DIR/.env" ]]; then
    echo "UI environment file not found: $UI_DIR/.env" >&2
    exit 1
fi

echo "[1/7] Pull latest code"
cd "$APP_DIR"
git pull --ff-only

echo "[2/7] Install and build UI"
cd "$UI_DIR"
npm ci
npm run build

echo "[3/7] Install API dependencies"
cd "$API_DIR"
poetry install --only main

echo "[4/7] Apply database migrations"
poetry run alembic upgrade head

echo "[5/7] Publish an atomic static release"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_DIR" rev-parse --short HEAD)"
releases_dir="$WEB_ROOT/releases"
release_dir="$releases_dir/$release_name"
next_link="$WEB_ROOT/.current-$release_name"

sudo mkdir -p "$release_dir"
sudo rsync -a --delete "$UI_DIR/dist/" "$release_dir/"
sudo chown -R root:www-data "$release_dir"
sudo find "$release_dir" -type d -exec chmod 755 {} \;
sudo find "$release_dir" -type f -exec chmod 644 {} \;
sudo ln -s "$release_dir" "$next_link"
sudo mv -Tf "$next_link" "$WEB_ROOT/current"

echo "[6/7] Restart API service"
sudo systemctl restart "$API_SERVICE"

echo "[7/7] Validate and reload Nginx"
sudo nginx -t
sudo systemctl reload nginx

echo "Deployment complete: $release_dir"
