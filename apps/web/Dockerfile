# Web container — serves the static HTML on :3000. Reverse-proxy this behind
# Caddy/nginx along with the API in production.
FROM node:22-alpine

WORKDIR /app

COPY apps/web ./apps/web
COPY package.json ./

ENV PORT=3000
EXPOSE 3000

# BUILD_SHA + BUILT_AT injected by CI so dev-server.js can stamp the served
# HTML with the running build. The FE polls /api/version and reloads when
# this value diverges from the API's BUILD_SHA — that is how we force stale
# browser tabs to drop the old JS after a deploy.
ARG BUILD_SHA=unknown
ARG BUILT_AT=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILT_AT=${BUILT_AT}

CMD ["node", "apps/web/src/dev-server.js"]
