# PaperSprocket MCP server — stdio MCP container.
# For local Postman MCP / MCP Inspector use. The API key must be provided at
# runtime via the PAPERSPROCKET_API_KEY environment variable or a mounted .env
# (never baked into an image).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY .env.example ./

# .env is expected to be mounted/created at runtime by the operator.
ENTRYPOINT ["node", "server.js"]