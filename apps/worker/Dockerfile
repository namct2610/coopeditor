# Worker container — runs ffmpeg + MinIO upload.
# Image includes ffmpeg from the Alpine package (CPU-only by default).
# For NVENC, build from nvidia/cuda base instead and set FFMPEG_HWACCEL=nvenc.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY package.json pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --filter @frame-editor/worker... --prod --frozen-lockfile=false

COPY apps/worker ./apps/worker
COPY apps/api ./apps/api

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
CMD ["node", "apps/worker/src/bootstrap.js"]
