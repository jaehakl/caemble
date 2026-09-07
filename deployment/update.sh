#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu/caemble}
API_DIR=${API_DIR:-$APP_DIR/app/api}
WEB_ROOT=${WEB_ROOT:-/var/www/caemble}
API_SERVICE=${API_SERVICE:-caemble-api}
NGINX_CONFIG_TARGET=${NGINX_CONFIG_TARGET:-/etc/nginx/sites-available/caemble.conf}

echo "[1/6] Fetch and stage the incoming release without changing the active checkout"
cd "$APP_DIR"
git diff --quiet
git diff --cached --quiet
git fetch --prune
incoming_commit="$(git rev-parse --verify '@{upstream}^{commit}')"
git merge-base --is-ancestor HEAD "$incoming_commit"
git read-tree --dry-run -m -u HEAD "$incoming_commit"

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/caemble-deploy.XXXXXX")"
nginx_changed=false
had_nginx_config=false
gate_owned=false
transition_started=false
cleanup() {
    status=$?
    trap - EXIT
    if [[ "$status" != 0 && "$transition_started" == false && "$nginx_changed" == true ]]; then
        if [[ "$had_nginx_config" == true ]]; then
            sudo install -m 644 "$staging_dir/previous-app.conf" "$NGINX_CONFIG_TARGET" || true
        else
            sudo rm -f "$NGINX_CONFIG_TARGET" || true
        fi
        sudo nginx -t && sudo systemctl reload nginx || true
    fi
    if [[ "$gate_owned" == true ]]; then
        sudo rm -f /run/caemble-draining || true
    fi
    rm -f "$staging_dir/check-cae-drain.py" "$staging_dir/app.conf" "$staging_dir/caemble-ui.tar.gz" || true
    sudo rm -f "$staging_dir/previous-app.conf" || true
    rmdir "$staging_dir" || true
    exit "$status"
}
trap cleanup EXIT

git show "$incoming_commit:deployment/check-cae-drain.py" > "$staging_dir/check-cae-drain.py"
if [[ -n "${NGINX_CONFIG_SOURCE:-}" ]]; then
    cp "$NGINX_CONFIG_SOURCE" "$staging_dir/app.conf"
else
    git show "$incoming_commit:deployment/app.conf" > "$staging_dir/app.conf"
fi
if [[ -n "${UI_ARTIFACT:-}" ]]; then
    cp "$UI_ARTIFACT" "$staging_dir/caemble-ui.tar.gz"
else
    git show "$incoming_commit:deployment/caemble-ui.tar.gz" > "$staging_dir/caemble-ui.tar.gz"
fi
tar -tzf "$staging_dir/caemble-ui.tar.gz" >/dev/null

if sudo test -e /run/caemble-draining; then
    echo "A deployment admission gate already exists. Resolve the existing deployment before retrying." >&2
    exit 1
fi
if sudo test -e "$NGINX_CONFIG_TARGET"; then
    sudo cp "$NGINX_CONFIG_TARGET" "$staging_dir/previous-app.conf"
    had_nginx_config=true
fi

echo "[2/6] Close new batch admissions and drain the existing API"
nginx_changed=true
sudo install -m 644 "$staging_dir/app.conf" "$NGINX_CONFIG_TARGET"
sudo nginx -t
gate_owned=true
sudo touch /run/caemble-draining
sudo systemctl reload nginx
cd "$API_DIR"
api_service_installed=false
if sudo systemctl cat "$API_SERVICE" >/dev/null 2>&1; then
    api_service_installed=true
    poetry run python "$staging_dir/check-cae-drain.py" --env "$API_DIR/.env"
    sudo systemctl stop "$API_SERVICE"
fi

echo "[3/6] Activate the pinned API and Catalog, install dependencies, and migrate"
transition_started=true
git -C "$APP_DIR" merge --ff-only "$incoming_commit"
poetry install --only main
poetry run alembic upgrade head

echo "[4/6] Publish the static release"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_DIR" rev-parse --short HEAD)"
releases_dir="$WEB_ROOT/releases"
release_dir="$releases_dir/$release_name"
next_link="$WEB_ROOT/.current-$release_name"

sudo mkdir -p "$release_dir"
sudo tar --no-same-owner -xzf "$staging_dir/caemble-ui.tar.gz" -C "$release_dir"
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
sudo install -m 644 "$staging_dir/app.conf" "$NGINX_CONFIG_TARGET"
sudo systemctl reload nginx

echo "Deployment complete: $release_dir"
