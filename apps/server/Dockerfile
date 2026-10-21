FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm install --workspace @pilotix/shared --workspace @pilotix/server --include-workspace-root=false
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY db db
RUN npm run build -w @pilotix/shared && npm run build -w @pilotix/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
