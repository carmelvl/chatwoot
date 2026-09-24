# Zero runtime dependencies: Node 24 runs TypeScript natively (type stripping) and ships node:sqlite.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080 BRIDGE_DB_PATH=/data/bridges.sqlite
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
