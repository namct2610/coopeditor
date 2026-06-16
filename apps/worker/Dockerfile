# Worker container — runs ffmpeg + MinIO upload.
# Image includes ffmpeg from the Alpine package (CPU-only by default).
# For NVENC, build from nvidia/cuda base instead and set FFMPEG_HWACCEL=nvenc.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY package.json pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --filter @coopeditor/worker... --prod --frozen-lockfile=false

COPY apps/worker ./apps/worker
COPY apps/api ./apps/api
# Worker imports ../../../packages/contracts/src/event-bus.js (PG channel name,
# Redis stream key, envelope helpers). Without this COPY the image is missing
# the file and the container exit-loops on startup with ERR_MODULE_NOT_FOUND.
COPY packages/contracts ./packages/contracts

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
# BUILD_SHA + BUILT_AT injected by CI so /version endpoint reports the running build.
ARG BUILD_SHA=unknown
ARG BUILT_AT=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILT_AT=${BUILT_AT}
CMD ["node", "apps/worker/src/bootstrap.js"]
