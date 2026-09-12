# 多阶段构建：先编译，再运行
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci

# 复制源码并编译
COPY . .
RUN npm run build

# 生产镜像
FROM node:20-alpine

WORKDIR /app

# 仅复制生产依赖与编译产物
COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/prisma ./src/prisma

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 启动前执行 Prisma migrate deploy，再启动服务
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
