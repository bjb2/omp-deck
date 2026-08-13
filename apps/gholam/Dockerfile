# Gholam sidecar Dockerfile — installs the omp-deck monorepo so the
# workspace provides hono (apps/gholam only declares it as a peer via
# `hono`), then runs the sidecar on port 47900.
FROM oven/bun:1.3.14-alpine

WORKDIR /repo

# Copy the entire monorepo so the workspace dependency graph is intact.
# The sidecar only reads from apps/gholam at runtime, but `bun install`
# needs the root package.json + bun.lock to resolve hono from the workspace.
COPY package.json bun.lock ./
COPY apps/gholam/package.json ./apps/gholam/
COPY packages ./packages
COPY apps ./apps

# Install at the workspace root so apps/gholam can resolve workspace deps.
RUN bun install --frozen-lockfile

WORKDIR /repo/apps/gholam

ENV GHOLAM_WS_PORT=47900
ENV NODE_ENV=production

EXPOSE 47900

# Health probe — the sidecar serves a JSON /health on the same port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:47900/health || exit 1

CMD ["bun", "src/index.ts"]
