# deda-server

Deda 微信小程序后端服务（MVP 框架）。

## 技术栈

- **运行时**：Node.js 20 + NestJS 10
- **数据库**：PostgreSQL 16 + Prisma ORM
- **缓存/队列**：Redis 7（ioredis）
- **日志**：Pino
- **部署**：Docker + Docker Compose + Nginx（阿里云 ECS）

## 项目结构

```
deda-server/
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── src/
│   ├── common/
│   │   ├── filters/          # 全局异常过滤器
│   │   ├── interceptors/     # 统一响应拦截器
│   │   ├── pipes/            # 参数解析管道
│   │   ├── prisma/           # Prisma 模块与服务
│   │   └── redis/            # Redis 模块与服务
│   ├── config/               # 应用/数据库/Redis 配置
│   ├── modules/              # 业务模块
│   │   ├── users             # 用户账号（微信登录、手机号绑定）
│   │   ├── devices           # 设备管理、状态查询、控制转发、绑定、WiFi 下发
│   │   ├── child-profiles    # 孩子档案
│   │   ├── textbooks         # 教材与单元元数据
│   │   ├── device-configs    # 设备学习配置下发、模式/语言/语速同步
│   │   ├── conversations     # 对话记录查询与删除
│   │   ├── learning-stats    # 学习统计与进度
│   │   ├── webhooks          # 接收厂商 Webhook
│   │   ├── manufacturer      # 我方调用机芯厂商 API 客户端
│   │   ├── vendor            # 机芯厂调用我方的 WebSocket/HTTP 接口
│   │   └── music             # 音乐播放控制与网易云音乐绑定
│   ├── prisma/
│   │   └── schema.prisma     # 数据库模型
│   ├── app.module.ts
│   └── main.ts
├── .env.example
├── nest-cli.json
├── package.json
└── tsconfig.json
```

## 本地开发

### 1. 安装依赖

```bash
cd /Users/xiong/Desktop/deda-server
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写数据库、Redis、微信、厂商 API 等配置
```

### 3. 启动 PostgreSQL 与 Redis

```bash
docker-compose -f docker/docker-compose.yml up -d postgres redis
```

### 4. 初始化数据库

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 5. 启动开发服务

```bash
npm run start:dev
```

服务默认运行在 `http://localhost:3000`，Swagger 文档地址：`http://localhost:3000/api/docs`。

## 生产部署（阿里云 ECS）

### 1. 准备服务器

- 购买阿里云 ECS（建议 2 核 4G 起步，CentOS/Ubuntu）
- 开放 80、443、3000 端口
- 安装 Docker 与 Docker Compose

### 2. 配置域名与 HTTPS

- 将域名（如 `api.deda.example.com`）解析到 ECS 公网 IP
- 使用 Certbot 申请 Let's Encrypt 证书
- 修改 `nginx/nginx.conf` 中的域名与证书路径

### 3. 配置环境变量

```bash
cp .env.example .env
# 填写生产环境配置
```

### 4. 构建并启动

```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

### 5. 查看日志

```bash
docker logs -f deda-server
```

## 数据库迁移

```bash
# 开发环境生成迁移
npx prisma migrate dev --name <migration-name>

# 生产环境应用迁移
npx prisma migrate deploy
```

## 接口文档

启动服务后访问：`http://localhost:3000/api/docs`

## 注意事项

- 当前框架仅包含模块骨架与数据库模型，具体业务接口实现需后续补充。
- 厂商 API 基地址、微信小程序 AppID/Secret 等敏感信息通过环境变量注入，不要提交到代码仓库。
- Webhook 接收接口建议配合 Redis 做幂等校验与流量缓冲。
