FROM node:22-alpine AS build
WORKDIR /app
# the exact versions of package-lock.json (every package and the packages they use), no install scripts run: a new
# release of any package never reaches the server without a commit that changes the lock
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @pilotix/shared --workspace @pilotix/core --workspace @pilotix/server --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/server apps/server
RUN npm run build -w @pilotix/shared && npm run build -w @pilotix/core && npm run build -w @pilotix/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# the planned posts' videos (a volume in deploy/docker-compose.yml): the server's own folder
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 3000
CMD ["sh", "-c", "node apps/server/dist/migrate.js && node apps/server/dist/main.js"]
