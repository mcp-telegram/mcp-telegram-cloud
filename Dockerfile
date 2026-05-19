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

# Stage 3: Production runtime — Bun runs .ts directly, no build step
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
RUN mkdir -p /app/data
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
