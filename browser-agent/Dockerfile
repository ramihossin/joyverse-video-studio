FROM mcr.microsoft.com/playwright:v1.64.1-noble
USER root
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --chown=pwuser:pwuser . ./
RUN node --check server.js && node --check store.js && npm test
RUN mkdir -p /data /tmp/joyverse-agent-uploads \
    && chown -R pwuser:pwuser /app /data /tmp/joyverse-agent-uploads
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV DOWNLOAD_DIR=/data/downloads
ENV UPLOAD_DIR=/tmp/joyverse-agent-uploads
EXPOSE 8080
USER pwuser
CMD ["npm","start"]
