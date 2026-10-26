# The website (React app) built for this shop's address, served by Caddy with HTTPS. Caddy also forwards /api and
# /live (live updates) to the Pilotix server, so the app and its server share one address.
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund
ARG DOMAIN
ENV VITE_API_URL=https://${DOMAIN} VITE_BASE=/ VITE_DEMO=0
RUN npm run build -w @pilotix/web

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# a configuration Caddy refuses stops the update here, while the running version keeps serving the site
RUN DOMAIN=example.com caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY --from=build /app/apps/web/dist /srv
