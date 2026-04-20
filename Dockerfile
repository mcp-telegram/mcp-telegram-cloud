# Stage 1: Build mcp-telegram from source (with declarations)
FROM node:22-alpine AS telegram-lib
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/mcp-telegram/mcp-telegram.git /telegram
WORKDIR /telegram
RUN npm ci && npm run build

# Stage 2: Build cloud app
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
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
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "dist/server.js"]
