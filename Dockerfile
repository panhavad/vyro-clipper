# syntax=docker/dockerfile:1.7
# VyroClipper: client-side AI clipping studio + helper server with git-driven auto-update.
ARG NODE_VERSION=24

# ---- dependencies (cached separately from sources) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev

# ---- build the web studio + Chrome extension ----
FROM deps AS build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ARG GIT_MESSAGE=""
COPY . .
RUN GIT_COMMIT="${GIT_COMMIT}" GIT_BRANCH="${GIT_BRANCH}" GIT_MESSAGE="${GIT_MESSAGE}" npm run build \
  && npm test

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# git: auto-update · ffmpeg + python3 + yt-dlp: fetching YouTube/TikTok/Instagram/X source links
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ffmpeg python3 tini \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && git config --system --add safe.directory '*'
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    MEDIA_CACHE_DIR=/data/media
# node_modules + sources stay in the image so the supervisor can rebuild new commits in-container.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/supervisor.ts"]
