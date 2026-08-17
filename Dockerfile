FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json tsconfig.web.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chown=node:node config ./config
COPY --chown=node:node knowledge ./knowledge
RUN mkdir -p /app/data && chown node:node /app/data
USER node

CMD ["node", "dist/server.js"]
