# Multi-stage build with production dependencies and compiled output only.

FROM node:22-alpine AS build

# better-sqlite3 compiles its native binding from source at install time —
# there is no prebuilt binary for this platform/Node combination (found
# rehearsing restore on Atlas, M8 part 2/3) — so a C++ toolchain is a real
# build-time dependency, not an optional extra.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drops devDependencies (and the C++ toolchain's own footprint) from the
# node_modules the runtime stage copies — the compiled native binding, built
# above against this same Alpine/musl base, stays intact through the prune.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
# Every committed config the runtime loads. Listed as a directory copy with
# an explicit ignore for the personal file, rather than one COPY per file:
# M10 added config/taxonomy.yaml and nobody added the matching COPY, so the
# container crash-looped on ENOENT the first time it was deployed. A new
# config should not be able to break the image by omission.
#
# Safe as a directory copy specifically because .dockerignore excludes
# config/profile.yaml: on Atlas that file DOES exist next to the others
# (compose bind-mounts it from the host checkout), so without that ignore
# this would bake the personal profile into an image layer — the exact thing
# ADR-004 forbids. The ignore is what makes this safe; do not remove it.
COPY config/ ./config/

# The stage A/B prompt templates, which `prompts.ts` reads at scoring time by
# relative path. Same omission as config/taxonomy.yaml above, and it shipped:
# `prompts` was listed in .dockerignore, so the directory never entered the
# build context and `/app/prompts` did not exist in the image at all. It stayed
# invisible because a scoreAndDeliver run that filters down to zero postings
# never loads a prompt — the first run with something to score, 2026-08-16,
# was also the first to hit it. A directory copy, for the same reason config/
# is one: a new prompt version must not be able to break the image by omission.
COPY prompts/ ./prompts/

# config/profile.yaml (gitignored, personal — ADR-004) and .env are never
# baked into the image; compose.production.yaml mounts/injects them at
# runtime. data/ (the SQLite database) is a named volume, not a layer.

CMD ["node", "dist/main.js"]
