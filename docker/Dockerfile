## Build stage: compile TypeScript for both the server (API + CLI) and the
## web UI.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY server/package.json server/tsconfig.json ./server/
COPY web/package.json web/tsconfig.json web/vite.config.ts ./web/

RUN npm install

COPY server ./server
COPY web ./web

RUN npm run build -w server
RUN npm run build -w web

## Runtime stage: ffmpeg + vainfo for Intel VAAPI hardware transcoding, plus
## the compiled server and web output. No native build toolchain is needed
## here because Shrinkarr uses Node's built-in node:sqlite module.
FROM node:22-slim AS runtime
WORKDIR /app

## The open-source intel-media-va-driver has HEVC hardware encode disabled
## on many platforms for patent-licensing reasons; intel-media-va-driver-non-free
## (Debian's non-free component) ships the full encode feature set, which is
## what actually enables VAAPI HEVC encoding on Intel iGPUs like the Apollo
## Lake graphics in a Synology DS218+.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg vainfo intel-media-va-driver-non-free \
  && rm -rf /var/lib/apt/lists/*

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./server/web-dist

ENV NODE_ENV=production
ENV SHRINKARR_CONFIG=/app/config/config.yaml

EXPOSE 3000

CMD ["node", "server/dist/cli/index.js", "start", "--port", "3000"]
