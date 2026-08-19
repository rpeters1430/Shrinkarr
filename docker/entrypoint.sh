#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Remap the built-in `node` user/group to match the host UID/GID the NAS
# (Synology, UGREEN, etc.) expects, so files Shrinkarr writes into mounted
# media/config/data volumes come out owned by the same user your other
# containers (Jellyfin, Sonarr, Radarr...) already use, instead of a
# container-only UID that the NAS's file browser can't make sense of.
if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
  usermod -o -u "$PUID" node
fi

mkdir -p /app/config /app/data
chown -R node:node /app/config /app/data

exec gosu node "$@"
