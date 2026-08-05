FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY mediatorConfig.json ./

EXPOSE 3500

CMD ["node", "src/index.js"]
