## Build stage: compile TypeScript for both the server (API + CLI) and the
## web UI. Pinned to $BUILDPLATFORM rather than the final target platform --
## this is a pure JS/TS compile with no native dependencies, so it only
## ever needs to run natively on the CI runner. Building an arm64 image on
## an amd64 runner (or vice versa) skips QEMU emulation entirely for this
## stage, which is most of the build's wall-clock time.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
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
FROM node:22-slim AS runtime
ARG TARGETARCH
WORKDIR /app

## Intel VAAPI/QuickSync drivers only exist for amd64 -- the CPUs in devices
## like a Synology DS218+ (Celeron J3355) or a UGREEN DXP4800 Plus. On arm64
## builds this is skipped entirely; Shrinkarr's hardware detection falls
## back to CPU encoding automatically (see server/src/transcode/hardware.ts).
##
## The open-source intel-media-va-driver has HEVC hardware encode disabled
## on many platforms for patent-licensing reasons; intel-media-va-driver-non-free
## (Debian's non-free component) ships the full encode feature set, which is
## what actually enables VAAPI HEVC encoding on Intel iGPUs.
##
## gosu is used by entrypoint.sh to drop from root to the `node` user after
## remapping it to match the host's PUID/PGID.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
      && apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg vainfo intel-media-va-driver-non-free gosu \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg gosu \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --no-audit --no-fund

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
