# webfetch — a networked web-fetch service.
#
#   POST /fetch { "url": "..." } -> { "title", "text", "final_url", "method" }
#   GET  /health
#
# Build and run (from this directory):
#   docker build -t webfetch .
#   docker run -p 9000:9000 webfetch
# Then point a client (e.g. raven-rs's `webfetch` plugin) at http://<host>:9000/fetch
#
# NOTE: this image downloads the Camoufox (Firefox fork) browser at build time, so it is
# large and slow to build. The system-lib set below is best-effort for Camoufox; trim or
# extend it once a real build confirms what the browser actually needs on this base image.
FROM node:22-slim

# System libraries Camoufox (a Firefox fork) needs, plus xvfb for a virtual display in case
# the humanized launch wants one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation fonts-noto-color-emoji \
      libgtk-3-0 libdbus-glib-1-2 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpangocairo-1.0-0 libcups2 \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching). better-sqlite3 is a native module and is
# compiled against this image's Node during install.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources to dist/.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# Download the Camoufox browser at build time so the container is ready to fetch on first request.
RUN node node_modules/camoufox-js/dist/__main__.js fetch

ENV PORT=9000
ENV WEBFETCH_HEADLESS=true
EXPOSE 9000

# xvfb-run supplies a virtual display if the browser needs one while headless.
CMD ["xvfb-run", "-a", "node", "dist/server.js"]
