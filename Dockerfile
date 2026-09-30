# Builds the client to static files and publishes them into a volume that
# Caddy serves. There is no server in this image and no port -- the container
# runs once, copies, and exits.
#
# The same shape as the migrate service: a one-shot job built from the source
# the VPS just pulled, gated so nothing depends on it until it succeeds.

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# Dependencies first, so a source-only change does not reinstall them.
# pnpm-workspace.yaml rides along because it carries the allowBuilds entry
# for esbuild -- without it pnpm 11 refuses the build script and the
# install fails, which is exactly what took deploy #514 down.
#
# Which pnpm: corepack reads package.json's `packageManager`, the version CI
# pins (deploy.yml, release.yml); bump them together. Before the pin the
# client had none, so corepack took whatever was newest -- deploy #514's pnpm
# 11, and pnpm 12.4.2 in the 2026-09-18 deploy while CI checked the lockfile
# with 11.
#
# Frozen, with no fallback. `|| pnpm install` used to retry any failure
# unfrozen, resolving the ^ ranges afresh on the VPS: production could ship
# versions CI never ran, and a drifted ts-mls would build without the
# patch patchedDependencies pins to 1.6.4 (MLS on Safari and Android
# WebView). A lockfile problem now fails the build, the old containers keep
# serving, and the deploy goes red -- the same fail-closed shape as migrate.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

# Declared last, right before the one step that reads it, so a source-only
# change does not bust the layers above -- same placement reasoning as the
# server Dockerfile's GIT_SHA. Vite embeds any VITE_-prefixed env var into
# the bundle automatically (see sync/engine.ts's BUILD_COMMIT and
# ui/Settings.tsx's TIP_URL), so nothing in vite.config.ts has to know
# either exists. VITE_TIP_URL defaults to empty, which is what keeps the
# tip-jar section out of the rendered Settings page entirely when an
# operator has not configured one.
#
# GIT_VERSION/VITE_APP_VERSION is the same mechanism a second time, for the
# tag-derived version (sync/engine.ts's APP_VERSION) -- "unknown" by default,
# same as GIT_SHA, for exactly the same dev/plain-build cases.
ARG GIT_SHA=unknown
ARG GIT_VERSION=unknown
ARG VITE_TIP_URL=
ENV VITE_COMMIT_SHA=$GIT_SHA
ENV VITE_APP_VERSION=$GIT_VERSION
ENV VITE_TIP_URL=$VITE_TIP_URL
RUN pnpm build

# alpine rather than node: nothing here runs JavaScript, it copies files.
FROM alpine:3 AS publish
COPY --from=build /app/dist /dist
# index.html is set aside so the publish can put it in place last, alone.
RUN mv /dist/index.html /index.html

# Publish into the volume Caddy is serving *while this runs*: compose gates
# Caddy on this container only on the first `up`; on every later deploy Caddy
# is already running and is not recreated. So the order matters, no file is
# ever rewritten in place, and nothing is deleted that a page might still ask
# for:
#
# 1. Every file but index.html goes in beside what is there. One already there
#    with the same bytes (most chunks, which are named by their hash) is only
#    touched; anything else is copied to a temporary name and renamed over,
#    which is atomic, so no request can read a half-written file. Either way
#    each file this build ships gets the time of this publish, so a file's age
#    below is how long ago it was last shipped.
# 2. index.html last, the same rename: a page load sees the old index or the
#    new one, and whichever it sees, the chunks it names are there. (It was
#    `rm -rf` then `cp`, so for a moment "/" was a 404 or an index naming
#    chunks not yet copied.)
# 3. A top-level file the build no longer has goes now (a public/ file
#    removed from the repo -- a stale sw.js must not outlive its source).
# 4. An asset not shipped for 14 days goes. Until then, a tab opened before a
#    deploy can still load its lazy chunks -- the call's E2EE worker is created
#    per call from one, and Safari's @noble fallbacks are others -- where the
#    delete used to leave it index.html (and now a 404, deploy/Caddyfile). This
#    is also what keeps the volume from growing without bound, the reason the
#    delete existed.
CMD set -e; \
    mkdir -p /srv/client/assets; \
    cd /dist; \
    find . -type f | while read -r f; do \
      d="/srv/client/${f#./}"; \
      if cmp -s "$f" "$d"; then touch "$d"; \
      else mkdir -p "${d%/*}"; cp "$f" "$d.new"; mv -f "$d.new" "$d"; fi; \
    done; \
    cp /index.html /srv/client/index.html.new; \
    mv -f /srv/client/index.html.new /srv/client/index.html; \
    cd /srv/client; \
    for f in *; do \
      case "$f" in assets|index.html) ;; *) [ -e "/dist/$f" ] || rm -rf "$f" ;; esac; \
    done; \
    find assets -type f -mtime +14 -exec rm -f {} +; \
    echo 'published:'; ls -1; \
    echo "assets kept: $(find assets -type f | wc -l)"
