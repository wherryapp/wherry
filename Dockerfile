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
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

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

# Replace the previous build rather than merging into it. Vite fingerprints
# asset filenames, so without the delete every deploy would leave the old
# chunks behind forever and the volume would grow without bound.
#
# There is a sub-second window during the copy where the volume is incomplete.
# It does not matter: compose gates Caddy on this container exiting
# successfully, so during a deploy nothing is serving from the volume yet.
CMD ["sh", "-c", "set -e; rm -rf /srv/client/*; cp -a /dist/. /srv/client/; echo 'published:'; ls -1 /srv/client"]
