FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build \
  && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The HTTP server exposes the MCP endpoint at /mcp.
EXPOSE 3000

USER node

CMD ["node", "dist/http-server.js"]
