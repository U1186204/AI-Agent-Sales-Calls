# syntax=docker/dockerfile:1
#
# Oasis production image (Next.js 16 + Prisma 7 + SQLite via better-sqlite3).
#
#   docker build -t oasis .
#   docker run --rm --init -p 3000:3000 --env-file .env -v oasis-data:/app/.data oasis
#
# Debian slim (glibc), not Alpine: better-sqlite3 and the Prisma schema engine ship
# prebuilt glibc binaries. The runtime keeps the full node_modules because boot-time
# migrate + seed need the Prisma CLI and tsx (dev dependencies). See docs/SPEC.md §3.

ARG NODE_IMAGE=node:24-slim

# ---- base: shared OS packages ---------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# openssl: Prisma's schema engine (migrate deploy) links libssl; ca-certificates: HTTPS APIs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- deps: install all dependencies (dev included, needed to build) ------------------
FROM base AS deps
# Toolchain only as a fallback if a better-sqlite3 prebuilt binary cannot be downloaded.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# postinstall runs `prisma generate`, which needs the schema and config.
COPY prisma.config.ts ./
COPY prisma ./prisma
# npm 11 runs install scripts only for packages approved in package.json "allowScripts"
# (better-sqlite3, prisma, @prisma/engines, esbuild, unrs-resolver).
RUN npm ci --include=dev --no-audit --no-fund

# ---- build: generate client + next build ---------------------------------------------
FROM deps AS build
COPY . .
RUN npx prisma generate \
 && npm run build \
 && rm -rf .next/cache

# ---- runtime ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:./.data/oasis.db \
    OUTBOX_DIR=.data/outbox \
    OASIS_SEED_ON_BOOT=if-empty

# Read-only app files (owned by root); only .next and .data are writable by the app user.
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts /app/prisma.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build --chown=node:node /app/.next ./.next

# Strip CRLF in case the repo was checked out on Windows without .gitattributes.
RUN sed -i 's/\r$//' scripts/docker-entrypoint.sh \
 && mkdir -p .data \
 && chown node:node .data

# The official image's unprivileged user (uid 1000).
USER node

VOLUME ["/app/.data"]
EXPOSE 3000

# Node 24 has global fetch; no curl in the slim image. start-period covers migrate + seed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
