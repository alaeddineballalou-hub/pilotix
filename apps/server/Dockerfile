FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN npm install --workspace @pilotix/shared --workspace @pilotix/core --workspace @pilotix/server --include-workspace-root=false --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/server apps/server
RUN npm run build -w @pilotix/shared && npm run build -w @pilotix/core && npm run build -w @pilotix/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "node apps/server/dist/migrate.js && node apps/server/dist/main.js"]
