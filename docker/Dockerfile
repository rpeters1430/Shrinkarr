# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

## Build stage: compile TypeScript for both the server (API + CLI) and the
## web UI. Pinned to $BUILDPLATFORM rather than the final target platform --
## this is a pure JS/TS compile with no native dependencies, so it only
## ever needs to run natively on the CI runner. Building an arm64 image on
## an amd64 runner (or vice versa) skips QEMU emulation entirely for this
## stage, which is most of the build's wall-clock time.
FROM --platform=$BUILDPLATFORM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/tsconfig.json ./server/
COPY web/package.json web/tsconfig.json web/vite.config.ts ./web/

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --no-audit --no-fund

COPY server ./server
COPY web ./web

RUN npm run build -w server && npm run build -w web

## Production dependencies, also on $BUILDPLATFORM. Every server runtime
## dependency is plain JavaScript (SQLite is Node's built-in node:sqlite), so
## the tree installed natively is identical to one installed under QEMU, and
## the arm64 image no longer runs `npm ci` emulated. The result is gathered in
## /out so the runtime stage takes it with one COPY whether or not npm needed
## a nested server/node_modules.
FROM --platform=$BUILDPLATFORM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --workspace server --omit=dev --no-audit --no-fund \
  && mkdir -p server/node_modules /out/server /out/web \
  && cp -a package.json node_modules /out/ \
  && cp -a server/package.json server/node_modules /out/server/ \
  && cp -a web/package.json /out/web/

## Runtime stage: ffmpeg + vainfo for Intel VAAPI hardware transcoding, plus
## the compiled server and web output. No native build toolchain is needed
## here because Shrinkarr uses Node's built-in node:sqlite module.
FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime
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
## remapping it to match the host's PUID/PGID. `passwd` supplies
## groupmod/usermod for that remapping, and `util-linux` supplies ionice,
## which the production runner uses when lowPriority is on.
##
## The debugging tools in the second package list are kept in the final
## image so a running container can be `exec`'d into and diagnosed in place
## -- process inspection, network troubleshooting, log paging, and quick
## edits to config files without needing to redeploy with extra tooling
## first. curl is kept for the same reason (hitting the health endpoint,
## downloading a file to inspect).
##
## Everything is one layer with one `apt-get update`: the package index is
## downloaded once instead of twice, and nothing a later layer deletes is
## left behind in an earlier one.
##
## CI passes the current UTC date as APT_REFRESH so this layer is rebuilt at
## least daily. Without it the GHA layer cache keeps serving an old layer and
## `apt-get upgrade` never picks up Debian security fixes, which then fail
## the Trivy scan.
ARG APT_REFRESH=unset
RUN echo "apt refresh: $APT_REFRESH" \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends curl gnupg ca-certificates passwd util-linux \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
  && VERSION_OS="$(awk -F'=' '/^ID=/{ print $NF }' /etc/os-release)" \
  && VERSION_CODENAME="$(awk -F'=' '/^VERSION_CODENAME=/{ print $NF }' /etc/os-release)" \
  && printf 'Types: deb\nURIs: https://repo.jellyfin.org/%s\nSuites: %s\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' \
       "$VERSION_OS" "$VERSION_CODENAME" "$TARGETARCH" > /etc/apt/sources.list.d/jellyfin.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       jellyfin-ffmpeg7 gosu pciutils tzdata \
       procps \
       iproute2 \
       iputils-ping \
       lsof \
       net-tools \
       bind9-dnsutils \
       jq \
       less \
       nano \
       busybox \
       sqlite3 \
       tcpdump \
       strace \
       file \
  && (update-pciids || true) \
  && ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && if [ -f /usr/lib/jellyfin-ffmpeg/vainfo ]; then ln -s /usr/lib/jellyfin-ffmpeg/vainfo /usr/local/bin/vainfo; fi \
  && apt-get purge -y gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# npm/corepack are build tools; the production server runs directly with Node.
# Removing their unused dependency trees avoids shipping their CVEs in the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/check-hardware.sh /usr/local/bin/check-hardware
COPY docker/shrinkarr-top.sh /usr/local/bin/shrinkarr-top
COPY --from=prod-deps /out/ ./
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./server/web-dist
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/check-hardware /usr/local/bin/shrinkarr-top /app/server/dist/cli/index.js \
  && ln -s /app/server/dist/cli/index.js /usr/local/bin/shrinkarr

## Last on purpose: CI writes a new build-info.json (version, commit, release
## notes) for every build, so anything copied after it is rebuilt every time.
## Copying it first used to throw away the cached apt layer on every build.
COPY build-info.json ./build-info.json

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
