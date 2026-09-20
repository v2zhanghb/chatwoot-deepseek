# 零依赖（只用 Node 内置模块），无需 npm install
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8789

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# 状态文件目录（映射/游标/outbox），建议挂载卷
RUN mkdir -p /app/data

EXPOSE 8789

CMD ["node", "src/server.js"]
