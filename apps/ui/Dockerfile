# Stage 1: deps — install workspace dependencies
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/crypto/package.json packages/crypto/
COPY packages/storage/package.json packages/storage/
COPY packages/auth/package.json packages/auth/
COPY packages/stacks/package.json packages/stacks/
COPY packages/updates/package.json packages/updates/
COPY packages/api/package.json packages/api/
COPY apps/ui/package.json apps/ui/
RUN mkdir -p apps/server && echo '{"name":"@procella/server","private":true}' > apps/server/package.json
RUN bun install

# Stage 2: build — compile UI static assets
FROM deps AS build
COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/ui/ apps/ui/
WORKDIR /app/apps/ui
RUN bun run build

# Stage 3: serve — Caddy static file server with SPA fallback
FROM caddy:2-alpine
COPY --from=build /app/apps/ui/dist /srv
COPY apps/ui/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
