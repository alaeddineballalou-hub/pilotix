# The website (React app) built for this shop's address, served by Caddy with HTTPS. Caddy also forwards /api and
# /live (live updates) to the Pilotix server, so the app and its server share one address.
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
# the exact versions of package-lock.json, no install scripts run (see apps/server/Dockerfile)
RUN npm ci --ignore-scripts --no-audit --no-fund
ARG DOMAIN
ENV VITE_API_URL=https://${DOMAIN} VITE_BASE=/ VITE_DEMO=0
# No type check here: Pilotix CI checks the types on GitHub, and deploy.yml only puts live a version whose CI is green.
# Checking them again on the server ran out of memory (« JavaScript heap out of memory », 25 Nov 2026: two deploys
# failed) while the running app shares the same machine.
RUN npm run build:server -w @pilotix/web

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# a configuration Caddy refuses stops the update here, while the running version keeps serving the site
RUN DOMAIN=example.com caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY --from=build /app/apps/web/dist /srv
