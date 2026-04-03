FROM node:20-alpine

# HF Spaces runs as user 1000
RUN adduser -D -u 1000 appuser

WORKDIR /app

# Copy package files first (layer cache — only reinstalls if deps change)
COPY package*.json ./

# Install production deps only
RUN npm ci --only=production

# Copy source
COPY . .

# Own everything as appuser
RUN chown -R appuser:appuser /app

USER appuser

# HF Spaces default port — must be 7860
EXPOSE 7860

# Healthcheck — HF uses this to know the space is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:7860/api/health || exit 1

CMD ["node", "server.js"]
