# ---- Base Stage ----
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init curl

# ---- Dependencies ----
FROM base AS dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production && \
    cp -R node_modules /prod_modules && \
    npm ci

# ---- Build ----
FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Production ----
FROM base AS production
ENV NODE_ENV=production
USER node

COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=dependencies /prod_modules ./node_modules
COPY --chown=node:node package.json ./

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
