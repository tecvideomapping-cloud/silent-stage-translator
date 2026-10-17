FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copia dependências primeiro para cache do Docker
COPY package*.json ./
RUN npm install --production

# Copia código fonte
COPY . .

# Expõe a porta dinâmica
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
