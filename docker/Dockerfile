# 多阶段构建：先编译，再运行
FROM node:20-alpine AS builder

WORKDIR /app

# Prisma 引擎需要 OpenSSL（Alpine 默认不带，缺失时引擎会误选 openssl-1.1.x 导致运行崩溃）
RUN apk add --no-cache openssl

# 安装依赖（含 devDependencies，编译与 prisma generate 需要）
# --ignore-scripts：跳过 husky prepare（镜像内无 .git）；Prisma Client 在下方显式生成
COPY package*.json ./
RUN npm ci --ignore-scripts

# 复制源码、生成 Prisma Client 并编译
COPY . .
RUN npx prisma generate --schema=src/prisma/schema.prisma
RUN npm run build

# 生产镜像
FROM node:20-alpine

WORKDIR /app

# 同上：Prisma 引擎运行时依赖 OpenSSL
RUN apk add --no-cache openssl

# 仅安装生产依赖（--ignore-scripts 理由同上；生成的 Prisma Client 从 builder 复制）
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Prisma CLI 在 devDependencies 中，但容器启动时要跑 migrate deploy，
# 因此从 builder 阶段复制 CLI 与已生成的 Client
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/prisma ./src/prisma

ENV NODE_ENV=production
ENV APP_PORT=3000

EXPOSE 3000

# 启动前执行 Prisma migrate deploy，再启动服务
# schema 必须显式指定（仓库内位于 src/prisma，非默认 prisma/ 目录）
# 注意：无 tsconfig.build.json，nest build 保留目录结构，入口为 dist/src/main
CMD ["sh", "-c", "npx prisma migrate deploy --schema=src/prisma/schema.prisma && node dist/src/main"]
