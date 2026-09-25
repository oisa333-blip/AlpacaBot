FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# Self-running bot by default; use "node index.js" for the TradingView webhook server instead.
CMD ["node", "bot.js"]
