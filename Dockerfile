# 2nd Brain Studio — the single container image.
#
# One Node process serves the Hono API and the built React SPA, and shells out to
# the two Python tools the ingest pipeline needs (yt-dlp, youtube-transcript-api).
# All state lives on the /data volume, so the image itself is stateless and holds
# no secret: every credential is read from the environment at run time.
#
# Stages:
#   workspace    — the manifests plus the whole workspace installed from the lockfile
#   web-build    — the Vite SPA build            -> apps/web/dist
#   server-build — the server's TypeScript build -> apps/server/dist
#   runtime      — production dependencies only, the pinned Python toolchain,
#                  a non-root user that owns /data
#
# The runtime stage installs production dependencies from the same manifests
# instead of copying the build stage's node_modules, so no dev dependency
# (vite, typescript, vitest) and no pnpm store reaches the final image.

# ---- workspace: install the workspace from the committed lockfile -----------
FROM node:22-bookworm-slim AS workspace

# corepack installs the pnpm the root manifest pins (packageManager), so an image
# build uses the same package manager as every local run. The prompt is disabled
# because nothing is there to answer it during a build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable

# Manifests first, so this layer stays cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/okf/package.json packages/okf/
RUN pnpm install --frozen-lockfile

# Then the sources. .dockerignore keeps node_modules, dist, the two read-only
# reference checkouts and every env file out of the context, so this cannot
# clobber the install above.
COPY . .

# ---- web-build: the SPA ----------------------------------------------------
FROM workspace AS web-build
RUN pnpm --filter @2nd-brain/web build

# ---- server-build: the API and the job runner ------------------------------
FROM workspace AS server-build
# The okf package must be emitted before the server builds: its exports point at
# `dist/index.js`+`dist/index.d.ts`, so the runtime artifact has to exist.
RUN pnpm --filter @2nd-brain/okf build
RUN pnpm --filter @2nd-brain/server build

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DENO_DIR=/tmp/deno-cache

# yt-dlp breaks when YouTube changes and is a build-time install here: the image
# pins yt-dlp, its EJS solver, Deno and youtube-transcript-api, and refreshing
# any of them needs a redeploy — see deploy/coolify/README.md. All four land in
# a single layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages \
      yt-dlp==2026.8.19 \
      yt-dlp-ejs==0.8.0 \
      deno==2.9.8 \
      youtube-transcript-api==1.2.4 \
 && deno --version \
 && python3 -c "import yt_dlp_ejs" \
 && yt-dlp --js-runtimes deno --version \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

# Production dependencies only, resolved from the same lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/okf/package.json packages/okf/
RUN pnpm install --frozen-lockfile --prod

# The built output. The server resolves the SPA and the vault templates from its
# working directory, so the layout below mirrors a local checkout at /app.
COPY --from=server-build /repo/apps/server/dist ./apps/server/dist
COPY --from=server-build /repo/packages/okf/dist ./packages/okf/dist
COPY --from=server-build /repo/templates ./templates
COPY --from=web-build /repo/apps/web/dist ./apps/web/dist

# The server imports @2nd-brain/okf at run time. Fail the build here rather than
# on the first request if the emitted entry or its module wiring is broken.
RUN cd apps/server && node -e "import('@2nd-brain/okf').then(() => console.log('@2nd-brain/okf loads'))"

# Vault data lives on the volume, and the service user owns it. Creating the
# mount point in the image also gives a fresh named volume the right ownership.
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /data/vaults \
 && chown -R app:app /data
USER app

EXPOSE 3010
VOLUME ["/data/vaults"]

# The working directory stays at the repository root so apps/web/dist and
# templates/ resolve exactly as they do when the same command runs locally.
CMD ["node", "apps/server/dist/index.js"]
