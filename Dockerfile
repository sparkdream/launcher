# SparkDream Chain Launcher — single container: conductor + static web UI +
# sparkdreamd binary (§2 dual-mode: same image locally and on Akash).
#
# The sparkdreamd binary is copied from the chain image; keep the tag in sync
# with the launch-spec profiles (packages/launch-spec/src/profiles.ts).
ARG SPARKDREAMD_IMAGE=sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24

FROM ${SPARKDREAMD_IMAGE} AS chainbin

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
COPY tsconfig.base.json ./
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:22-alpine
# openssl: Akash client certs · age: backup/bundle encryption · tar: bundles
RUN apk add --no-cache openssl age tar openssh-client \
  && wget -qO- https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz \
     | tar xz -C /usr/local/bin litestream || echo "litestream download failed (offline build?) — replication disabled"

COPY --from=chainbin /usr/local/bin/sparkdreamd /usr/local/bin/sparkdreamd

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/apps/conductor/dist ./apps/conductor/dist
COPY --from=build /src/apps/conductor/node_modules ./apps/conductor/node_modules
COPY --from=build /src/apps/conductor/package.json ./apps/conductor/package.json
COPY --from=build /src/apps/web/out ./apps/web/out
COPY --from=build /src/vendor ./vendor
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DATA_DIR=/app/data \
    PORT=8080 \
    SPARKDREAM_VENDOR_DIR=/app/vendor/sparkdream-deploy
EXPOSE 8080
VOLUME /app/data

ENTRYPOINT ["/entrypoint.sh"]
