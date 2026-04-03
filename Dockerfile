FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

# node:20-alpine already has 'node' user at uid 1000 — just use it
RUN chown -R node:node /app

USER node

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:7860/api/health || exit 1

CMD ["node", "server.js"]
