FROM node:26.8-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS builder

ARG S3_PUBLIC_ENDPOINT=http://localhost:9000

ENV NEXT_TELEMETRY_DISABLED=1 \
    S3_PUBLIC_ENDPOINT=$S3_PUBLIC_ENDPOINT

WORKDIR /build
COPY . .
RUN corepack enable \
    && corepack pnpm install --frozen-lockfile \
    && corepack pnpm build \
    && corepack pnpm exec tsup --config scripts/tsup.config.ts

FROM node:26.8-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && rm -rf /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm

WORKDIR /app
COPY --from=builder --chown=1000:1000 /build/apps/web/.next/standalone/ ./
COPY --from=builder --chown=1000:1000 /build/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=builder --chown=1000:1000 /build/apps/worker/dist/index.cjs ./apps/worker/dist/index.cjs
COPY --from=builder --chown=1000:1000 /build/apps/github-control/dist/index.cjs ./apps/github-control/dist/index.cjs
COPY --from=builder --chown=1000:1000 /build/scripts/dist/migrate-db.mjs ./scripts/migrate-db.mjs
COPY --from=builder --chown=1000:1000 /build/packages/db/migrations/ ./packages/db/migrations/
RUN find /app -type f -name '*.map' -delete \
    && find /app/node_modules -type d \
      \( -name test -o -name tests -o -name __tests__ \) \
      -prune -exec rm -rf '{}' '+' \
    && find /app/node_modules -type d -path '*/next/dist/compiled/tar' \
      -prune -exec rm -rf '{}' '+'

USER 1000:1000

CMD ["node", "apps/web/server.js"]
