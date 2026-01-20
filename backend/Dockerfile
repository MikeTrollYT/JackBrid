FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY app.js jackettClient.js alldebridClient.js ./
RUN mkdir -p /app/downloads
VOLUME ["/app/downloads"]
CMD ["node", "app.js"]