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
# Two transports, one image:
#   stdio (default):  docker run -i --rm -e PLANKA_BASE_URL -e PLANKA_API_KEY <image>
#   multi-user HTTP:  docker run --rm -e MCP_TRANSPORT=http -e PLANKA_BASE_URL -p 3000:3000 <image>
# HTTP mode listens on PORT (default 3000); keep it on a private network.
EXPOSE 3000
# Probes /healthz in HTTP mode; always healthy in stdio mode (no port to probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["node", "dist/index.js"]
