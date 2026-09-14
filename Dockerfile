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
# NOTE: the runtime image downloads the Camoufox (Firefox fork) browser at build time, so it is
# large and slow to build. The system-lib set below is best-effort for Camoufox; trim or extend it
# once a real build confirms what the browser actually needs on this base image.

# --- builder ------------------------------------------------------------------
# better-sqlite3 is a native module. node:22-slim ships no build toolchain and no matching
# prebuilt binary is pulled for this Node ABI, so npm ci compiles it from source with node-gyp —
# which needs python3 + make + g++. Do that here, in a throwaway stage, so the runtime image never
# carries a compiler.
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching). This compiles better-sqlite3 against this
# image's Node — the runtime stage uses the same base, so the ABI matches.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies so only the runtime dependency tree (with the compiled better-sqlite3)
# is copied into the runtime image.
RUN npm prune --omit=dev

# --- runtime ------------------------------------------------------------------
FROM node:22-slim

# System libraries Camoufox (a Firefox fork) needs, plus xvfb for a virtual display in case
# the humanized launch wants one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation fonts-noto-color-emoji \
      libgtk-3-0 libdbus-glib-1-2 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpangocairo-1.0-0 libcups2 \
      xvfb xauth tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in the compiled production dependencies and the built sources from the builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Download the Camoufox browser at build time so the container is ready to fetch on first request.
RUN node node_modules/camoufox-js/dist/__main__.js fetch

ENV PORT=9000
ENV WEBFETCH_HEADLESS=true
EXPOSE 9000

# tini as PID 1: reaps zombies and forwards signals, and — critically — lets the
# xvfb-run shell script actually start its child. As PID 1 itself, xvfb-run brings up
# Xvfb but never launches node; under tini the process tree is tini -> xvfb-run -> node.
ENTRYPOINT ["/usr/bin/tini", "--"]

# xvfb-run supplies a virtual display if the browser needs one while headless.
CMD ["xvfb-run", "-a", "node", "dist/server.js"]
