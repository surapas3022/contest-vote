# contest-vote in a container. Data (votes, photos, TLS cert) lives in the /data volume.
#   docker compose up -d --build        (see "Run with Docker" in the README)
FROM node:22-alpine

# openssl: makes the self-signed certificate when HTTPS_PORT is set
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000

# dependencies first, so code changes do not reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# run as the unprivileged "node" user (uid 1000 in the node image); only /data is writable
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000

EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/state" > /dev/null || exit 1

# node handles SIGTERM itself (saves data, then exits), so `docker stop` is clean
CMD ["node", "server.js"]
