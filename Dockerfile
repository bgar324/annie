FROM node:24.8-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable \
  && apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build \
  && pnpm prune --prod

FROM node:24.8-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN apt-get update \
  && apt-get install --yes --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/main.js"]
