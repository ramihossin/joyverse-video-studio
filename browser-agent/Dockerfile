FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]
