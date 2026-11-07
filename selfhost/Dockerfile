FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY index.html vite.config.ts tsconfig.json tsconfig.server.json ./
RUN npm run build

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm

COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
COPY migrations ./migrations
COPY scripts/apply-migrations.mjs ./scripts/apply-migrations.mjs
COPY src/shared/runtime-tables.json ./src/shared/runtime-tables.json
COPY src/server/runtime-boundary.mjs ./src/server/runtime-boundary.mjs
COPY selfhost/runtime.mjs ./selfhost/runtime.mjs
COPY selfhost/drill-data.mjs ./selfhost/drill-data.mjs

EXPOSE 4310
USER node
ENTRYPOINT ["node", "selfhost/runtime.mjs"]
CMD ["web"]
