# Web container — serves the static HTML on :3000. Reverse-proxy this behind
# Caddy/nginx along with the API in production.
FROM node:22-alpine

WORKDIR /app

COPY apps/web ./apps/web
COPY package.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "apps/web/src/dev-server.js"]
