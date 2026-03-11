# Stage 1: Build mcp-telegram from source (with declarations)
FROM node:22-slim AS telegram-lib
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/overpod/mcp-telegram.git /lib
WORKDIR /lib
RUN npm ci && npm run build

# Stage 2: Build cloud app
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
# Replace npm registry version with source-built version
COPY --from=telegram-lib /lib /app/node_modules/@overpod/mcp-telegram
COPY . .
RUN npm run build

# Stage 3: Production
FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "dist/server.js"]
