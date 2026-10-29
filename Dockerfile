# syntax=docker/dockerfile:1

# Build stage: compile TypeScript with dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Runtime stage: production dependencies, compiled output, and the files the
# server reads at runtime (src/resources.ts serves docs/ and workflow/ as MCP
# resources, resolved relative to dist/).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docs ./docs
COPY workflow ./workflow
COPY LICENSE CREDITS.md ./
USER node
# stdio transport: run with `docker run -i --rm`.
ENTRYPOINT ["node", "dist/index.js"]
