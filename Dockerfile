# syntax=docker/dockerfile:1

# Vite emits plain static assets — no native addons, nothing arch-specific — so
# the build runs once on the builder's own arch and the result is copied into
# each target runtime. No QEMU, so a two-platform build (linux/amd64 +
# linux/arm64) costs no more than one.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
# VITE_BASE is deliberately left unset: the image serves the app at the
# container root, unlike the GitHub Pages build which lives under /web/.
# VITE_ENABLE_UMAMI is left unset too — this image configures analytics at
# runtime from the environment instead (see docker/40-write-config.sh).
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
LABEL org.opencontainers.image.source="https://github.com/41tunnels/opencharui"
ARG VERSION=dev
LABEL org.opencontainers.image.version="${VERSION}"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# --chmod, so the exec bit does not depend on the checkout's file mode — the
# nginx entrypoint only runs the scripts in this directory that are executable.
COPY --chmod=755 docker/40-write-config.sh /docker-entrypoint.d/40-write-config.sh
# Owned by the image's own uid so the entrypoint can rewrite config.json.
COPY --chown=101:101 --from=build /src/dist /usr/share/nginx/html

EXPOSE 8080
# alpine ships no curl; busybox wget is already here.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
