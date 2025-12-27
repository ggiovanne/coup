FROM node:20-alpine

WORKDIR /app

# Copia apenas os manifests do servidor para instalar dependências
COPY server/package.json /app/server/package.json
COPY server/package-lock.json /app/server/package-lock.json

RUN cd /app/server && npm install --production

# Copia o código do servidor
COPY server /app/server

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]

