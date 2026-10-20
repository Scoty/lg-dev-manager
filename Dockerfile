# LG Dev Manager in Docker: the bridge in LAN mode, serving the web app to browsers on your network. Run it with
# compose.yaml (host networking — needed for the TV scan and for the local-network check). Published as
# ghcr.io/scoty/lg-dev-manager by .github/workflows/release-docker.yml.
#
# The image holds exactly the npm package (lg-dev-manager-bridge, with the web app inside), as `npx` would run it.

ARG NODE_VERSION=24.21.0

# ---- Build: the npm package and its production dependencies. Plain JavaScript (no native add-ons), so it is built
# once on the build machine's platform and copied into every target platform's image.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm build \
 && cd apps/bridge && pnpm pack --pack-destination /tmp/pkg
# ws's and ssh2's optional native add-ons are left out; both fall back to JavaScript (as in the standalone app).
RUN mkdir -p /app /data \
 && cd /app && npm init -y >/dev/null \
 && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund /tmp/pkg/lg-dev-manager-bridge-*.tgz \
 && rm package.json package-lock.json

# ---- Runtime: Node.js, the package, and an empty /data for the pairing token. Nothing runs at build time here, so
# images for other platforms need no emulation.
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    LGDM_DISTRIBUTION=docker \
    LGDM_STATE_DIR=/data \
    LGDM_LISTEN=0.0.0.0 \
    LGDM_PORT=5199
WORKDIR /app
COPY --from=build /app /app
COPY --from=build --chown=node:node /data /data
# Not root. The pairing token in /data is the only thing the bridge writes; the rest can be read-only.
USER node
VOLUME /data
EXPOSE 5199
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.LGDM_PORT || 5199}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/node_modules/lg-dev-manager-bridge/dist/cli.js"]
