# Release v1.43.4: immutable source identity shared by build and runtime label.
ARG MCP_TELEGRAM_COMMIT=7f951e5bf16cbd2ec16b6e328dc5f65415d84e42

# Stage 1: Build mcp-telegram from source (with declarations)
# Core lib (mcp-telegram) is npm-native but Bun compiles it fine.
# `python3 make g++` no longer needed: --ignore-scripts skips native addon build
# for utf-8-validate/bufferutil; the JS fallback is identical.
FROM oven/bun:1.4.4-alpine AS telegram-lib
ARG MCP_TELEGRAM_COMMIT
RUN apk add --no-cache git
RUN git init /telegram \
    && git -C /telegram remote add origin https://github.com/mcp-telegram/mcp-telegram.git \
    && git -C /telegram fetch --depth 1 origin "${MCP_TELEGRAM_COMMIT}" \
    && git -C /telegram checkout --detach FETCH_HEAD \
    && test "$(git -C /telegram rev-parse HEAD)" = "${MCP_TELEGRAM_COMMIT}"
WORKDIR /telegram
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build

# Stage 2: Install cloud deps via bun.
# IMPORTANT: do NOT copy web/ and app/ manifests here. With workspace manifests
# present, bun pulls the entire workspace graph (Next, swc, react-icons, sharp
# ~= 940MB) into its .bun store even under --production. Root-only package.json
# keeps the backend tree at ~48MB and --frozen-lockfile still holds.
# `--ignore-scripts` skips native compilation for `utf-8-validate` and
# `bufferutil` (optional speedups for `ws`); the JS fallback is identical.
FROM oven/bun:1.4.4-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=telegram-lib /telegram /app/node_modules/@overpod/mcp-telegram

# Stage 2b: Build the React backend pages (app/ workspace) — client island
# bundles + SSR bundles. Needs dev deps (vite, react) so it's a separate stage
# from the prod-only `builder`; only the built dist/ + dist-ssr/ are copied into
# the runtime, keeping it lean (React lives only inside the SSR bundles, never
# in the backend's deps). If this stage's output were ever absent the server
# falls back to the legacy hono pages (reactPagesAvailable() === false).
FROM oven/bun:1.4.4-alpine AS app-builder
# Build the app workspace only: `--filter` installs just its dependencies (no
# Next.js/web graph) and `--frozen-lockfile` takes them from the committed root
# bun.lock, so the SSR bundles that run inside the backend are built from the
# reviewed versions instead of whatever `^` ranges resolve to today. The web
# manifest is copied only because the lockfile lists that workspace.
# --ignore-scripts skips the husky `prepare` hook (no .git here). Bun on Alpine
# occasionally flakes on install (IntegrityCheckFailed) — retry once.
WORKDIR /build
COPY package.json bun.lock ./
COPY app/package.json ./app/package.json
COPY web/package.json ./web/package.json
RUN bun install --frozen-lockfile --ignore-scripts --filter mcp-telegram-app \
  || bun install --frozen-lockfile --ignore-scripts --filter mcp-telegram-app
# Copy only sources/configs (NOT the host's app/node_modules or dist) so the
# install above isn't clobbered.
COPY app/src ./app/src
COPY app/tsconfig.json app/biome.json app/vite.config.ts app/vite.ssr.config.ts ./app/
WORKDIR /build/app
RUN bun run build

# Stage 3: Production runtime — Bun runs .ts directly, no build step
FROM oven/bun:1.4.4-alpine
ARG MCP_TELEGRAM_COMMIT
LABEL io.mcp-telegram.core.revision="${MCP_TELEGRAM_COMMIT}"
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
# React page bundles (client islands + SSR), read at runtime by src/react-pages.ts.
# app/src is copied too because the SSR bridge imports the app's pure-TS i18n
# (detectLocale) directly from source.
COPY --from=app-builder /build/app/dist ./app/dist
COPY --from=app-builder /build/app/dist-ssr ./app/dist-ssr
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
