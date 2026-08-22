#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/caemble}
API_DIR=${API_DIR:-$APP_DIR/app/api}
UI_ARTIFACT=${UI_ARTIFACT:-$APP_DIR/deployment/caemble-ui.tar.gz}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}
NGINX_CONFIG_SOURCE=${NGINX_CONFIG_SOURCE:-$APP_DIR/deployment/app.conf}
NGINX_CONFIG_TARGET=${NGINX_CONFIG_TARGET:-/etc/nginx/sites-available/caemble.conf}

for command_name in git grep install poetry sudo tar; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 1
    fi
done

if [[ ! -d "$APP_DIR/.git" ]]; then
    echo "Repository not found at $APP_DIR" >&2
    exit 1
fi

echo "[1/8] Pull latest code and UI artifact"
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

echo "[2/8] Install API dependencies"
cd "$API_DIR"
poetry install --only main

echo "[3/8] Validate the versioned SQLite catalog"
poetry run catalogctl --database ../catalog/caemble_catalog/catalog.sqlite3 validate

api_service_installed=false
if sudo systemctl cat "$API_SERVICE" >/dev/null 2>&1; then
    api_service_installed=true
    echo "[4/8] Stop API service for database migration"
    sudo systemctl stop "$API_SERVICE"
else
    echo "[4/8] API service is not installed yet; no migration stop is required"
fi

migration_succeeded=false
restart_api_on_failure() {
    exit_code=$?
    if [[ "$exit_code" -ne 0 && "$api_service_installed" == true ]]; then
        if [[ "$migration_succeeded" == true ]]; then
            echo "Deployment failed after migration; restarting the API on the migrated schema" >&2
            sudo systemctl start "$API_SERVICE" || true
        else
            echo "Migration failed; leaving the API stopped to avoid running new code on the old schema" >&2
            echo "Resolve the migration failure, then rerun this deployment or restore the previous release" >&2
        fi
    fi
    exit "$exit_code"
}
trap restart_api_on_failure EXIT

echo "[5/8] Apply database migrations"
poetry run alembic upgrade head
migration_succeeded=true

echo "[6/8] Publish an atomic static release"
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

echo "[7/8] Start API service"
if [[ "$api_service_installed" == true ]]; then
    sudo systemctl restart "$API_SERVICE"
else
    echo "API service is not installed yet; skipping restart: $API_SERVICE"
fi

echo "[8/8] Install, validate and reload Nginx"
if sudo test -f "$NGINX_CONFIG_TARGET"; then
    sudo install -m 644 "$NGINX_CONFIG_SOURCE" "$NGINX_CONFIG_TARGET"
else
    echo "Final Nginx config is not installed yet; skipping config sync: $NGINX_CONFIG_TARGET"
fi
sudo nginx -t
sudo systemctl reload nginx

echo "Deployment complete: $release_dir"
trap - EXIT
