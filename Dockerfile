# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY evals ./evals
# `pnpm build` goes through scripts/run-recursive.mjs, so the image needs it too.
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter @melra/cli --prod /release

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime

LABEL org.opencontainers.image.source="https://github.com/XAGI-Lab/melra"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.title="MELRA"
LABEL org.opencontainers.image.description="Safe, reliable, and verifiable MCP execution runtime"

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV MELRA_BROWSER=/usr/bin/chromium
ENV MELRA_WORKSPACE=/workspace
ENV MELRA_HOME=/data

WORKDIR /opt/melra
COPY --from=build --chown=node:node /release ./
# The deployed CLI brings its own LICENSE; NOTICE names the parts contributed
# under Apache-2.0, whose text is in LICENSES/.
COPY NOTICE ./
COPY LICENSES ./LICENSES/

RUN mkdir -p /workspace /data \
    && chown -R node:node /workspace /data \
    && chmod 700 /data

USER node
VOLUME ["/workspace", "/data"]
ENTRYPOINT ["node", "/opt/melra/dist/bin.js"]
CMD ["serve"]
