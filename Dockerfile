# Stage 1: Build mcp-telegram from source (with declarations)
FROM node:22-alpine AS telegram-lib
# python3/make/g++ needed when transitive native modules (e.g. utf-8-validate)
# fall back to source build on architectures without prebuilt binaries (arm64).
RUN apk add --no-cache git python3 make g++
RUN git clone --depth 1 https://github.com/mcp-telegram/mcp-telegram.git /telegram
WORKDIR /telegram
# Upstream `mcp-telegram` is an npm project (not pnpm); use npm ci here.
# Stage 2 below uses pnpm, which is what the cloud project itself uses.
RUN npm ci && npm run build

# Stage 2: Build cloud app
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# pnpm v10+ blocks postinstall scripts by default; better-sqlite3 is
# allow-listed in package.json#pnpm.onlyBuiltDependencies so its
# native binding gets compiled here.
RUN pnpm install --frozen-lockfile
# Replace npm registry version with source-built version (includes .d.ts)
COPY --from=telegram-lib /telegram /app/node_modules/@overpod/mcp-telegram
COPY . .
RUN pnpm run build

# Stage 3: Production
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
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
CMD ["node", "dist/server.js"]
