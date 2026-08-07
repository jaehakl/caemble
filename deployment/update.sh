#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/caemble}
API_DIR=${API_DIR:-$APP_DIR/app/api}
UI_ARTIFACT=${UI_ARTIFACT:-$APP_DIR/deployment/caemble-ui.tar.gz}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}

for command_name in git grep poetry sudo tar; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 1
    fi
done

if [[ ! -d "$APP_DIR/.git" ]]; then
    echo "Repository not found at $APP_DIR" >&2
    exit 1
fi

echo "[1/7] Pull latest code and UI artifact"
cd "$APP_DIR"
git pull --ff-only

if [[ ! -f "$UI_ARTIFACT" ]]; then
    echo "UI artifact not found: $UI_ARTIFACT" >&2
    exit 1
fi

if ! artifact_entries="$(tar -tzf "$UI_ARTIFACT")"; then
    echo "UI artifact is not a readable gzip tar archive: $UI_ARTIFACT" >&2
    exit 1
fi
if ! grep -Fxq "./index.html" <<<"$artifact_entries"; then
    echo "UI artifact does not contain index.html: $UI_ARTIFACT" >&2
    exit 1
fi
if ! grep -Fxq "./runner.html" <<<"$artifact_entries"; then
    echo "UI artifact does not contain runner.html: $UI_ARTIFACT" >&2
    exit 1
fi
if [[ ! -f "$API_DIR/.env" ]]; then
    echo "API environment file not found: $API_DIR/.env" >&2
    exit 1
fi

echo "[2/7] Install API dependencies"
cd "$API_DIR"
poetry install --only main

echo "[3/7] Apply database migrations"
poetry run alembic upgrade head

echo "[4/7] Publish an atomic static release"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_DIR" rev-parse --short HEAD)"
releases_dir="$WEB_ROOT/releases"
release_dir="$releases_dir/$release_name"
next_link="$WEB_ROOT/.current-$release_name"

sudo mkdir -p "$release_dir"
sudo tar --no-same-owner -xzf "$UI_ARTIFACT" -C "$release_dir"
sudo test -f "$release_dir/index.html"
sudo test -f "$release_dir/runner.html"
sudo chown -R root:www-data "$release_dir"
sudo find "$release_dir" -type d -exec chmod 755 {} \;
sudo find "$release_dir" -type f -exec chmod 644 {} \;
sudo ln -s "$release_dir" "$next_link"
sudo mv -Tf "$next_link" "$WEB_ROOT/current"

echo "[5/7] Restart API service"
if sudo systemctl cat "$API_SERVICE" >/dev/null 2>&1; then
    sudo systemctl restart "$API_SERVICE"
else
    echo "API service is not installed yet; skipping restart: $API_SERVICE"
fi

echo "[6/7] Validate and reload Nginx"
sudo nginx -t
sudo systemctl reload nginx

echo "[7/7] Keep the tracked UI artifact for the next git pull"
echo "Deployment complete: $release_dir"
