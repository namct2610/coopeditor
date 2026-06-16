# API container — runs the REST + SSE server.
FROM node:22-alpine

WORKDIR /app

# Install only api deps (pg). We copy package.json first so the layer is cached
# between code changes.
COPY apps/api/package.json ./apps/api/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY package.json pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --filter @coopeditor/api... --prod --frozen-lockfile=false

# Now copy sources
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY release.json ./release.json

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# BUILD_SHA + BUILT_AT injected by docker compose at build time so the running
# container knows its own version. `docker compose build` reads these from .env.
ARG BUILD_SHA=unknown
ARG BUILT_AT=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILT_AT=${BUILT_AT}

CMD ["node", "apps/api/src/bootstrap.js"]
