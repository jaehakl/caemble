#!/usr/bin/env bash
set -euo pipefail

checkout_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for installer_python in python3.12 python3 python; do
  if command -v "$installer_python" >/dev/null 2>&1 &&
    "$installer_python" -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
    exec "$installer_python" -X utf8 "$checkout_dir/app/launcher/install.py" "$@"
  fi
done
printf '%s\n' 'Launcher installation requires Python 3.11+ to run this script and Python 3.12 for new environments.' >&2
exit 1
