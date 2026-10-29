# Collaboration server as a Vercel Services container.
# Why a container, not the plain Node runtime: this server is a long-lived
# HTTP + WebSocket process (http.createServer + ws), not a function handler.
# A plain Node service would not run it as written; the container runtime
# does, listening on $PORT (Vercel's default container port is 80).
# See docs/VERCEL.md for the limits this does NOT remove: Hobby function
# duration, scale-down, and no cross-instance broadcast without Redis.
FROM node:20-bookworm-slim

WORKDIR /app

# Install production dependencies first so this layer is cached.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Vercel's container runtime routes traffic to $PORT (default 80).
# server.js honours PORT first, then COLLABORATION_PORT, then 8787.
ENV NODE_ENV=production
EXPOSE 80

CMD ["node", "src/server.js"]
