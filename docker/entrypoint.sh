#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Remap the built-in `node` user/group to match the host UID/GID the NAS
# (Synology, UGREEN, etc.) expects, so files Shrinkarr writes into mounted
# media/config/data volumes come out owned by the same user your other
# containers (Jellyfin, Sonarr, Radarr...) already use.
if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node 2>/dev/null || true
  usermod -o -u "$PUID" -g "$PGID" node 2>/dev/null || true
fi

# Dynamically add the node user to the host's video and render groups
# to ensure zero-friction hardware acceleration access to /dev/dri/*
if [ -d /dev/dri ]; then
  for dev in /dev/dri/card* /dev/dri/renderD*; do
    [ -e "$dev" ] || continue
    DEV_GID=$(stat -c '%g' "$dev" 2>/dev/null || true)
    if [ -n "$DEV_GID" ] && [ "$DEV_GID" != "0" ]; then
      DEV_GRP=$(getent group "$DEV_GID" | cut -d: -f1 || true)
      if [ -z "$DEV_GRP" ]; then
        DEV_GRP="host_gpu_$DEV_GID"
        groupadd -g "$DEV_GID" "$DEV_GRP" 2>/dev/null || true
      fi
      usermod -a -G "$DEV_GRP" node 2>/dev/null || true
    fi
  done
fi

mkdir -p /app/config /app/data
chown -R node:node /app/config /app/data

exec gosu node "$@"

