FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.mjs ./

ENV WEBSITES_PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
