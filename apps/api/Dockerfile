# API container — runs the REST + SSE server.
FROM node:22-alpine

WORKDIR /app

# Install only api deps (pg). We copy package.json first so the layer is cached
# between code changes.
COPY apps/api/package.json ./apps/api/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY package.json pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --filter @frame-editor/api... --prod --frozen-lockfile=false

# Now copy sources
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "apps/api/src/bootstrap.js"]
