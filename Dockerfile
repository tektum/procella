# syntax=docker/dockerfile:1
FROM public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 AS adapter
FROM oven/bun:1.4.2 AS base
WORKDIR /usr/src/app

FROM base AS deps
COPY package.json bun.lock ./
COPY --parents ./*/*/package.json ./
RUN bun install --frozen-lockfile

FROM deps AS prod-deps
RUN bun prune --production

FROM base AS ui
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY packages/ packages/
COPY apps/ui/ apps/ui/
COPY tsconfig.json tsconfig.base.json ./
RUN bun run --cwd apps/ui build

FROM base AS build
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY tsconfig.json tsconfig.base.json ./
RUN bun build --compile \
    --production --sourcemap \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    apps/server/src/index.ts --outfile procella

FROM base AS lambda
WORKDIR /var/task
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=prod-deps /usr/src/app ./
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY tsconfig.json tsconfig.base.json ./
# Keep AWS_LWA_PASS_THROUGH_PATH unset so the adapter never bypasses Bun routes
# and cannot collide with the Pulumi /api/stacks/*/events/batch endpoint.
ENV PORT=8080
ENV READINESS_CHECK_PATH=/healthz
CMD ["bun", "run", "apps/server/src/lambda-bootstrap.ts"]

FROM gcr.io/distroless/cc-debian13 AS standalone
COPY --from=build /usr/src/app/procella /procella
COPY --from=build /usr/src/app/packages/db/drizzle /migrations
COPY --from=ui /usr/src/app/apps/ui/dist /ui
EXPOSE 9090
ENTRYPOINT ["/procella"]
