# Shrinkarr

A self-hosted media transcoding tool that scans your library, transcodes files
to space-saving codecs (H.265 via Intel VAAPI hardware acceleration, with a
CPU fallback), and notifies Jellyfin, Plex, Emby, Sonarr, and Radarr to
rescan when done. Designed to run as a single docker-compose service next to
your existing media stack, with sane defaults instead of a flow-plugin system
to configure.

## Quick start (Docker)

1. Copy the example config and edit it for your libraries:

   ```
   cp config/config.example.yaml config/config.yaml
   ```

   At minimum, set each `libraries[].path` to a path inside the `/media`
   mount you'll configure in `docker-compose.yml`, and fill in any
   `integrations` blocks for the services you want notified after a
   transcode (Jellyfin, Emby, Plex, Sonarr, Radarr — all optional).

2. Edit `docker-compose.yml` and point the media volume at your real media
   root:

   ```yaml
   volumes:
     - /path/to/media:/media
   ```

   Use the same host path your Jellyfin/Plex/Emby/Sonarr/Radarr containers
   already mount, so a file at `/media/movies/Foo.mkv` resolves to the same
   file in every container. If your host has an Intel GPU, leave the
   `/dev/dri` device passthrough in place for hardware-accelerated
   transcoding (VAAPI); otherwise remove that block and set `hwaccel: cpu` on
   your presets.

3. Start it:

   ```
   docker compose up -d
   ```

4. Open `http://localhost:3000` and click **Scan all libraries** on the
   dashboard, or trigger a scan per-library from the Library page. Files that
   qualify for transcoding (not already at the target codec, and estimated
   savings above your preset's threshold) get queued automatically; the
   built-in queue processor picks them up and works through them.

See `docker-compose.full-example.yml` for a complete example showing
Shrinkarr deployed alongside Jellyfin, Sonarr, and Radarr sharing one media
volume.

## Safety model

Shrinkarr never modifies a file until the transcoded output has been
verified against the original (duration, valid video/audio streams, nonzero
size). The new file is written to a temp file in the same directory as the
original and only atomically renamed into place after verification passes.
If anything fails, the original is left untouched and the job is marked
failed with a reason.

## CLI (headless / advanced use)

The same binary that powers the Docker image is available as a CLI inside
the `server` package (`npm run build -w server`, then
`node server/dist/cli/index.js <command>`):

- `shrinkarr scan --config path/to/config.yaml` — scan all configured
  libraries, print a report, and enqueue transcode jobs. Read-only; no files
  are modified.
- `shrinkarr run --config path/to/config.yaml` — start the queue processor as
  a foreground daemon (transcodes only, no HTTP API).
- `shrinkarr serve --config path/to/config.yaml --port 3000` — start the REST
  API only (no queue processing).
- `shrinkarr start --config path/to/config.yaml --port 3000` — start the API
  and the queue processor together; this is what the Docker image runs.

## Development

This is an npm workspaces monorepo: `server/` (Fastify API + CLI,
TypeScript) and `web/` (React + Vite UI).

```
npm install
npm run build       # builds both workspaces
npm run test         # runs the server test suite
npm run dev:server   # server/watch build
```

See `.plan/task_plan.md` for the phased implementation roadmap this project
was built from.
