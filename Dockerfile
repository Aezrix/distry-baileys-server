FROM node:20-slim

# Dependencias del sistema que necesita Baileys (openssl, ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# cache-bust: 2026-06-14c
COPY . .

ENV NODE_ENV=production

# SESSION_DIR se sobreescribe en Railway con la ruta del Volume montado
ENV SESSION_DIR=/app/baileys-auth

CMD ["node", "index.js"]
