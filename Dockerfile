# Stage 1: Build mcp-telegram from source (with declarations)
# Kept on node:22-alpine — upstream mcp-telegram is an npm project (not Bun),
# and its build emits .d.ts for the cloud's typecheck.
FROM node:22-alpine AS telegram-lib
RUN apk add --no-cache git python3 make g++
RUN git clone --depth 1 https://github.com/mcp-telegram/mcp-telegram.git /telegram
WORKDIR /telegram
RUN npm ci && npm run build

# Stage 2: Install cloud deps via npm (Bun's lockfile resolver hits sporadic
# IntegrityCheckFailed on Alpine — track in spike notes). npm reads
# package.json deterministically; Bun runtime in Stage 3 reads node_modules
# unchanged. `--ignore-scripts` skips native compilation for `utf-8-validate`
# and `bufferutil` (optional speedups for `ws`); the JS fallback is identical.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev --ignore-scripts
COPY --from=telegram-lib /telegram /app/node_modules/@overpod/mcp-telegram

# Stage 2b: Build the React backend pages (app/ workspace) — client island
# bundles + SSR bundles. Needs dev deps (vite, react) so it's a separate stage
# from the prod-only `builder`; only the built dist/ + dist-ssr/ are copied into
# the runtime, keeping it lean (React lives only inside the SSR bundles, never
# in the backend's deps). If this stage's output were ever absent the server
# falls back to the legacy hono pages (reactPagesAvailable() === false).
FROM oven/bun:1.3.14-alpine AS app-builder
# Build the app workspace standalone (its package.json is self-contained:
# react, react-dom, vite, @vitejs/plugin-react). Installing it in isolation
# avoids pulling the root workspace graph (Next.js/web deps) into this stage and
# sidesteps the husky `prepare` hook that needs a .git dir. Bun on Alpine
# occasionally flakes on install (IntegrityCheckFailed) — retry once.
WORKDIR /build
COPY app/package.json ./package.json
RUN bun install --ignore-scripts || bun install --ignore-scripts
# Copy only sources/configs (NOT the host's app/node_modules or dist) so the
# install above isn't clobbered.
COPY app/src ./src
COPY app/tsconfig.json app/biome.json app/vite.config.ts app/vite.ssr.config.ts ./
RUN bun run build

# Stage 3: Production runtime — Bun runs .ts directly, no build step
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
# React page bundles (client islands + SSR), read at runtime by src/react-pages.ts.
# app/src is copied too because the SSR bridge imports the app's pure-TS i18n
# (detectLocale) directly from source.
COPY --from=app-builder /build/dist ./app/dist
COPY --from=app-builder /build/dist-ssr ./app/dist-ssr
COPY app/src ./app/src
COPY app/package.json ./app/package.json
# Run as a non-root user (audit H3): a container RCE no longer lands as root.
# oven/bun:alpine ships a built-in `bun` user (uid/gid 1000) — reuse it rather
# than creating our own (gid 1000 is already taken by that user). `bun` owns the
# app tree + data dir. NOTE: the prod `data` volume is root-owned from earlier
# root containers, so the infra deploy chowns it to 1000:1000 (see deploy.yml).
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
ENV NODE_ENV=production
# Cloud distribution policy: opt-in upstream tools that are read-only and zero-cost
# are pre-enabled in the cloud image. Self-hosters can override these per-feature.
#  - MCP_TELEGRAM_ENABLE_GROUP_CALLS=1 : voice-chat metadata + participant listing
#  - MCP_TELEGRAM_ENABLE_QUICK_REPLIES=1 : quick-reply shortcut catalog + messages
# Telegram Stars (paid ecosystem) is intentionally NOT enabled — see parity-config.ts.
ENV MCP_TELEGRAM_ENABLE_GROUP_CALLS=1
ENV MCP_TELEGRAM_ENABLE_QUICK_REPLIES=1
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["bun", "src/server.tsx"]
