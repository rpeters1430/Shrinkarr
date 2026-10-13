#!/usr/bin/env bash
# Validate the candidate without touching a host media library.
set -euo pipefail
image=${1:?Usage: docker-smoke.sh IMAGE [PLATFORM]}
platform=${2:-linux/amd64}
name="shrinkarr-smoke-${platform##*/}-$$"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$name" || true; fi
  docker rm -fv "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --platform "$platform" --entrypoint sh "$image" -ec '
  for tool in ffmpeg ffprobe vainfo nice ionice groupmod usermod gosu; do command -v "$tool"; done
  ffmpeg -hide_banner -encoders > /tmp/encoders 2>/dev/null
  grep -q hevc_vaapi /tmp/encoders
  grep -q h264_vaapi /tmp/encoders
'
docker run --rm --platform "$platform" -e PUID=1000 -e PGID=10 "$image" shrinkarr --help
docker run -d --platform "$platform" --name "$name" \
  -e PUID=1000 -e PGID=10 -e TZ=America/Los_Angeles \
  --mount type=volume,destination=/app/config \
  --mount type=volume,destination=/app/data "$image"

ready=false
for attempt in $(seq 1 60); do
  if docker exec "$name" node -e '
    fetch("http://127.0.0.1:3000/api/health", {signal: AbortSignal.timeout(3000)})
      .then(r => { if (!r.ok) throw new Error(`Health: ${r.status}`); })
      .catch(() => process.exit(1));
  '; then ready=true; break; fi
  sleep 2
done
[ "$ready" = true ] || { echo "Server did not become ready on $platform" >&2; exit 1; }
docker exec "$name" sh -ec 'test "$(id -u node)" = 1000; test "$(id -g node)" = 10'
# Hosted runners have no GPU: this exercises the real FFmpeg/FFprobe binaries,
# while compiled VAAPI checks above cover capability availability only.
docker exec --user 1000:10 "$name" sh -ec '
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=128x128:rate=5 \
    -frames:v 2 -c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1 /tmp/smoke.mkv
  test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 /tmp/smoke.mkv)" = hevc
  rm /tmp/smoke.mkv
'
echo "Runtime passed: $platform ($image)"
