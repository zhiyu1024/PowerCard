FROM node:22-alpine

WORKDIR /app

# 零运行时依赖：只复制源码，不需要 npm install。
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONFIG_PATH=/app/data/config.json

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1

CMD ["node", "server/start.js"]
