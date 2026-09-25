# Node 24 runs TypeScript natively (type stripping) and ships node:sqlite. Deps: baileys + qrcode only.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production PORT=8090 WA_GROUPS_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/wa-groups/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
