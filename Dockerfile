# Image de production d'Entre Potes (utilisée sur le NUC).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dépendances d'abord : cette étape reste en cache tant que package*.json ne change pas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code de l'application (le .env et les images ne sont jamais copiés : voir .dockerignore).
COPY src ./src
COPY public ./public
COPY admin ./admin
COPY data/questions.json ./data/questions.json
COPY data/mculture ./data/mculture
COPY data/imposteur.json ./data/imposteur.json
COPY data/justeprix.json ./data/justeprix.json
COPY data/paint.json ./data/paint.json
COPY data/tictacboum ./data/tictacboum
COPY version.json ./

# Dossier des images Top Meme, accessible en écriture par l'utilisateur non-root "node".
RUN mkdir -p /app/data/memes && chown -R node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

CMD ["node", "src/server.js"]
