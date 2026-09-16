#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID" in
  ''|*[!0-9]*)
    echo "ERROR: PUID and PGID must be positive numeric IDs (received PUID=$PUID PGID=$PGID)." >&2
    exit 1
    ;;
esac

case "$PGID" in
  ''|*[!0-9]*)
    echo "ERROR: PUID and PGID must be positive numeric IDs (received PUID=$PUID PGID=$PGID)." >&2
    exit 1
    ;;
esac

if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "ERROR: PUID=0 or PGID=0 would run Shrinkarr as root; use the NAS media-owner IDs instead." >&2
  exit 1
fi

for required_command in groupmod usermod gosu ffmpeg ffprobe nice ionice; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "ERROR: Required runtime command '$required_command' is missing from the image." >&2
    exit 1
  fi
done

# Remap the built-in `node` user/group to match the host UID/GID the NAS
# (Synology, UGREEN, etc.) expects, so files Shrinkarr writes into mounted
# media/config/data volumes come out owned by the same user your other
# containers (Jellyfin, Sonarr, Radarr...) already use.
if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
  usermod -o -u "$PUID" -g "$PGID" node
fi

if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  echo "ERROR: Failed to remap the node account to PUID=$PUID PGID=$PGID." >&2
  exit 1
fi

# Configure container timezone if TZ is set
if [ -n "$TZ" ] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" > /etc/timezone
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

  render_node_found=false
  render_node_accessible=false
  for dev in /dev/dri/renderD*; do
    [ -e "$dev" ] || continue
    render_node_found=true
    if gosu node test -r "$dev" && gosu node test -w "$dev"; then
      render_node_accessible=true
      break
    fi
  done
  if [ "$render_node_found" = true ] && [ "$render_node_accessible" != true ]; then
    echo "WARNING: DRM render nodes are mounted but PUID=$PUID cannot read/write them; hardware encoding will fall back to CPU." >&2
  fi
fi

mkdir -p /app/config /app/data
chown -R node:node /app/config /app/data

exec gosu node "$@"
