FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# 零运行时依赖，直接拷贝源码即可
COPY package.json ./
COPY src ./src
COPY public ./public
COPY kb ./kb

EXPOSE 8787

# 健康检查使用 Node 内置 fetch，避免镜像内再装 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
