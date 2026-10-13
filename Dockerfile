# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build

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

FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS runtime

LABEL org.opencontainers.image.source="https://github.com/XAGI-Lab/melra"
LABEL org.opencontainers.image.licenses="Apache-2.0"
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

RUN mkdir -p /workspace /data \
    && chown -R node:node /workspace /data

USER node
VOLUME ["/workspace", "/data"]
ENTRYPOINT ["node", "/opt/melra/dist/bin.js"]
CMD ["serve"]
