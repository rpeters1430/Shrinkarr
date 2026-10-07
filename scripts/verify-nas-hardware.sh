#!/usr/bin/env bash
# Run on the NAS; only writes a temporary synthetic clip inside the container.
set -euo pipefail
container=${1:-shrinkarr}
device=${2:-/dev/dri/renderD128}
docker exec --user root -e TEST_RENDER_DEVICE="$device" "$container" gosu node sh -ec '
  test -r "$TEST_RENDER_DEVICE" && test -w "$TEST_RENDER_DEVICE"
  clip=$(mktemp /tmp/shrinkarr-vaapi-XXXXXX.mkv)
  trap '\''rm -f "$clip"'\'' EXIT
  ffmpeg -hide_banner -loglevel error -y -vaapi_device "$TEST_RENDER_DEVICE" \
    -f lavfi -i testsrc2=size=640x360:rate=10 -frames:v 10 \
    -vf format=p010,hwupload -c:v hevc_vaapi -profile:v main10 "$clip"
  test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$clip")" = hevc
  echo "HEVC Main10 VAAPI encode passed as UID $(id -u) / GID $(id -g) on $TEST_RENDER_DEVICE"
'
