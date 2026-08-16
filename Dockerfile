FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
