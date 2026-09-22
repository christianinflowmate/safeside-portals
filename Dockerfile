# syntax=docker/dockerfile:1
#
# One image, one process: the API serves its own routes and the built web client
# from the same origin. Two services would mean CORS, a second URL, and a session
# cookie that has to cross origins — all of which this avoids.
#
# Node 24 is not optional. The API runs TypeScript sources directly under Node's
# strip-only type stripping; there is no compile step to fall back to.

###############################################################################
# Stage 1 — build the web client.
#
# Vite and the whole React toolchain live here and go no further. The runtime
# image gets the static output and nothing that produced it.
###############################################################################
FROM node:24-bookworm-slim AS web

WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes,
# so editing source does not reinstall node_modules.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace=apps/web


###############################################################################
# Stage 2 — runtime.
###############################################################################
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CHROMIUM_NO_SANDBOX=1

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Production dependencies only. Playwright is one of them — the renderer imports
# it at runtime — which is why it is a dependency of apps/api and not a dev
# dependency of the root.
RUN npm ci --omit=dev

# Chromium and the system libraries a headless browser needs on a slim image:
# fontconfig, the X and GTK shared objects, and so on. --with-deps is what pulls
# them in. Only chromium is installed; Firefox and WebKit would be ~400MB unused.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY templates templates
COPY supabase supabase
COPY scripts scripts
COPY --from=web /app/apps/web/dist apps/web/dist

# Run unprivileged. Two directories need thought:
#
#   templates/ — the renderer writes a scratch HTML file here and opens it over
#   file://, because Chromium will not load file:// assets into a page created
#   with setContent(). See apps/api/src/documents/render.ts. So it is written to,
#   not just read, and must be owned by the account the server runs as.
#
#   /ms-playwright — installed as root above, so it needs to be world-readable
#   or the browser cannot be launched by anyone else.
RUN useradd --system --create-home --uid 10001 app \
 && chown -R app:app /app/templates \
 && chmod -R a+rX /ms-playwright
USER app

EXPOSE 3001

# Migrations are NOT run here. Applying them as a side effect of a process
# starting is how two instances race each other; fly.toml runs them once, in a
# release_command, before any new instance goes live.
CMD ["npm", "start", "--workspace=apps/api"]
