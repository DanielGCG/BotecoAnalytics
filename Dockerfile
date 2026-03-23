FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Expõe a porta 3002
EXPOSE 3002

# Comando para rodar migrations e iniciar o app
CMD ["sh", "-c", "npx sequelize-cli db:migrate && node index.js"]
