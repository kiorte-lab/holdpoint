FROM node:22-alpine
WORKDIR /app
COPY relay/ relay/
ENV PORT=8787 DATA_FILE=/data/wristgate-data.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "relay/server.js"]
