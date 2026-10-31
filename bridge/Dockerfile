FROM node:22-alpine
WORKDIR /app
COPY bridge/server.js ./server.js
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
