## Build stage: compile TypeScript for both the server (API + CLI) and the
## web UI. Pinned to $BUILDPLATFORM rather than the final target platform --
## this is a pure JS/TS compile with no native dependencies, so it only
## ever needs to run natively on the CI runner. Building an arm64 image on
## an amd64 runner (or vice versa) skips QEMU emulation entirely for this
## stage, which is most of the build's wall-clock time.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY server/package.json server/tsconfig.json ./server/
COPY web/package.json web/tsconfig.json web/vite.config.ts ./web/

RUN npm install --no-audit --no-fund

COPY server ./server
COPY web ./web

RUN npm run build -w server && npm run build -w web

## Runtime stage: ffmpeg + vainfo for Intel VAAPI hardware transcoding, plus
## the compiled server and web output. No native build toolchain is needed
## here because Shrinkarr uses Node's built-in node:sqlite module.
FROM node:24-slim AS runtime
ARG TARGETARCH
WORKDIR /app

## ffmpeg comes from Jellyfin's own apt repo (jellyfin-ffmpeg7) rather than
## Debian's ffmpeg package. Debian's ffmpeg pulls in a full desktop
## dependency chain (SDL2, X11, Mesa GL) meant for local playback that a
## headless transcoding server never uses, bloating the image by several
## hundred MB. jellyfin-ffmpeg7 is a self-contained build maintained by the
## Jellyfin project (which this app already integrates with directly),
## published via a GPG-signed apt repo for both amd64 and arm64 on Debian
## bookworm. It bundles its own Intel/Mesa VAAPI drivers plus vainfo, so
## nothing extra is needed for hardware transcoding on Intel iGPUs like the
## ones in a Synology DS218+ or a UGREEN DXP4800 Plus.
##
## gosu is used by entrypoint.sh to drop from root to the `node` user after
## remapping it to match the host's PUID/PGID.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
  && VERSION_OS="$(awk -F'=' '/^ID=/{ print $NF }' /etc/os-release)" \
  && VERSION_CODENAME="$(awk -F'=' '/^VERSION_CODENAME=/{ print $NF }' /etc/os-release)" \
  && printf 'Types: deb\nURIs: https://repo.jellyfin.org/%s\nSuites: %s\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' \
       "$VERSION_OS" "$VERSION_CODENAME" "$TARGETARCH" > /etc/apt/sources.list.d/jellyfin.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 gosu \
  && ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && ln -s /usr/lib/jellyfin-ffmpeg/vainfo /usr/local/bin/vainfo \
  && apt-get purge -y curl gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./server/web-dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV SHRINKARR_CONFIG=/app/config/config.yaml
ENV PUID=1000
ENV PGID=1000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

LABEL org.opencontainers.image.source="https://github.com/rpeters1430/Shrinkarr" \
      org.opencontainers.image.description="Self-hosted media storage optimizer and automated video transcoder" \
      org.opencontainers.image.licenses="MIT"

## Runs as root only long enough to remap the `node` user to PUID/PGID and
## fix volume ownership, then drops to that user via gosu -- see
## docker/entrypoint.sh.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/cli/index.js", "start", "--port", "3000"]
