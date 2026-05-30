# Metadata enrichment agent — Cloud Run Job image.
#
# Lives under agents/ (not connectors/) so the deploy-connectors
# workflow's directory-enumerated matrix doesn't try to build it as
# if it were a Meltano connector. This is a Node image running the
# bundled TypeScript agent entrypoint, not a Singer/Meltano pipeline.
#
# IMPORTANT: build context is the REPO ROOT, not this directory — the
# bundle needs src/, scripts/, tsconfig.json, and the lockfile. The
# deploy-metadata-agent workflow builds with:
#   docker build -f agents/metadata-agent/Dockerfile .
#
# Stages:
#   builder — install all deps, esbuild-bundle the entrypoint
#   runner  — fresh prod-only deps + the bundle; tiny runtime surface

# ── builder ───────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable

# Dependency layer — cached unless the manifest/lockfile change.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Source needed to produce the bundle. tsconfig.json carries the `@/*`
# path alias (also mirrored in the esbuild config).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build:metadata-agent

# ── runner ────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# Production dependencies only — esbuild and other devDeps are excluded.
# The bundle imports these as external packages at runtime.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# The bundled entrypoint (ESM single file).
COPY --from=builder /app/dist ./dist

# Cloud Run Jobs run the container's entrypoint to completion. The
# script reads connector context from env (injected as overrides by
# the dispatcher) and exits 0/1/2.
ENTRYPOINT ["node", "dist/metadata-agent/index.mjs"]
