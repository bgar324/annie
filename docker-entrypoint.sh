#!/bin/sh
set -eu

data_dir="${RAILWAY_VOLUME_MOUNT_PATH:-${DATA_DIR:-/app/data}}"
case "$data_dir" in
  /*) ;;
  *) echo "Data directory must be absolute inside the container" >&2; exit 1 ;;
esac
if [ "$data_dir" = "/" ]; then
  echo "Refusing to use the container root as the data directory" >&2
  exit 1
fi

install -d -o node -g node -m 0750 "$data_dir"
exec gosu node "$@"
