# deda-server

Deda 微信小程序后端服务，负责家长 App 设备管理、学习数据、对话记录，以及与机芯厂商云进行云对云（WebSocket + MQTT + HTTP）对接。

## 技术栈

- **运行时**：Node.js 20 + NestJS 10
- **数据库**：PostgreSQL 16 + Prisma ORM
- **缓存/队列**：Redis 7（ioredis）
- **日志**：Pino
- **部署**：Docker + Docker Compose + Nginx（阿里云 ECS）

## 通信链路完整版

```
┌─────────────┐     语音/按键      ┌─────────────────┐
│   用户/孩子  │ ───────────────> │   AI 玩具（机芯）  │
│             │ <─────────────── │                 │
└─────────────┘    语音回复        └────────┬────────┘
                                            │
                                            │ ASR 文字
                                            ▼
                                   ┌─────────────────┐
                                   │   机芯厂商云      │
                                   │  （ASR/TTS/设备管理）│
                                   └────────┬────────┘
                                            │
                       ┌────────────────────┼────────────────────┐
                       │ WebSocket          │ MQTT               │ HTTP 控制
                       │ vendor:text:in     │ zhianxin/event/report│
                       │ vendor:text:out    │ DEVICE_STATUS        │
                       │ vendor:ping/pong   │ CONVERSATION_RECORD  │
                       ▼                    ▼                    ▼
              ┌─────────────────────────────────────────────────────┐
              │                    deda-server                       │
              │  （NestJS / PostgreSQL / Redis / LLM + RAG）          │
              │                                                     │
              │  • 接收 ASR 文字，调用 LLM 生成回复                    │
              │  • 通过 WebSocket 返回回复文字给机芯厂商云              │
              │  • 订阅 MQTT 接收设备状态与会话记录                    │
              │  • 提供家长 App REST API                              │
              │  • 调用机芯厂商 HTTP API 控制设备                      │
              └────────────────────────┬────────────────────────────┘
                                       │
                                       │ REST API / JWT
                                       ▼
                              ┌─────────────────┐
                              │   家长微信小程序   │
                              │  （绑定/状态/聊天记录）│
                              └─────────────────┘
```

### 链路说明

1. **用户 ↔ 机芯**：孩子通过语音或按键与玩具交互；机芯负责本地 ASR（语音识别）和 TTS（语音合成）。
2. **机芯 ↔ 机芯厂商云**：机芯将 ASR 后的文字上传到机芯厂商云，厂商云将文字通过 WebSocket 转发给 deda-server，并将 deda-server 返回的文字通过 TTS 后下发给机芯播放。
3. **机芯厂商云 ↔ deda-server**：
   - **WebSocket `/vendor`**：双向文字通道与心跳。
     - `vendor:text:in`：机芯厂商云上传用户 ASR 文字。
     - `vendor:text:out`：deda-server 下发 AI 回复文字。
     - `vendor:ping` / `vendor:pong`：心跳保活。
   - **MQTT `zhianxin/event/report`**：机芯厂商云推送设备状态（`DEVICE_STATUS`）和会话记录（`CONVERSATION_RECORD`）。
   - **HTTP 厂商 API**：deda-server 主动调用机芯厂商云接口控制设备（音量、开关机、WiFi 下发、TTS 等）。
4. **deda-server ↔ 家长 App**：家长通过微信小程序绑定设备、查看设备状态、查看聊天记录、下发控制指令。

## 双方接口期望

### deda-server 需要机芯厂商云提供的接口/能力

| 能力 | 协议 / Topic | 说明 |
|------|-------------|------|
| ASR 文字上行 | WebSocket `vendor:text:in` | 将用户语音转文字后发送到 deda-server |
| 回复文字下行 | WebSocket `vendor:text:out` | 接收 deda-server 返回的 AI 回复文字 |
| 心跳 | WebSocket `vendor:ping` / `vendor:pong` | 维持长连接，检测对端存活 |
| 设备状态上报 | MQTT `zhianxin/event/report` (`DEVICE_STATUS`) | 在线、电量、版本、运行、网络状态 |
| 会话记录上报 | MQTT `zhianxin/event/report` (`CONVERSATION_RECORD`) | 用户与玩具的完整对话记录 |
| 设备控制 | HTTP API | 音量、开关机、打断模式、休眠、自动关机、WiFi 下发、TTS、音乐控制、OTA 等 |
| 设备信息查询 | HTTP API | 设备编码、固件版本、网络类型、配网状态等 |

### 机芯厂商云可以期望 deda-server 提供的接口

| 能力 | 协议 / 路径 | 说明 |
|------|------------|------|
| 文字通道 | WebSocket `/vendor` | 机芯厂商云作为客户端连接 |
| 健康检查（可选） | `GET /health` | 供机芯厂商云或负载均衡探活；机芯厂如不需要，可由业务接口响应替代 |
| 厂商 Webhook（备用） | `POST /vendor/health` | 现有备用 HTTP 接口 |

### 家长 App 可以期望 deda-server 提供的接口

| 能力 | 路径 | 说明 |
|------|------|------|
| 微信登录 | `POST /users/login` | 微信小程序登录 |
| 绑定设备 | `POST /devices/bind` | 家长扫码或输入码绑定设备 |
| 解绑设备 | `DELETE /devices/:id` | 当前用户解绑自己的设备 |
| 设备列表 | `GET /devices` | 查看当前用户绑定的设备 |
| 设备详情 | `GET /devices/:id` | 查看设备静态信息 |
| 设备状态 | `GET /devices/:id/status` | 查看设备最新在线、电量、网络等状态 |
| 设备成员 | `GET /devices/:id/members` | 查看设备绑定成员 |
| 控制设备 | `POST /devices/:id/control` | 音量、开关机、打断模式等 |
| 下发 WiFi | `POST /devices/:id/wifi` | 家长手机扫描后下发 WiFi 凭证 |
| 聊天记录 | `GET /conversations` | 查看绑定设备的聊天记录 |

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

## 环境隔离说明

项目支持三套环境，彼此隔离：

| 环境 | 用途 | 域名示例 | 机芯厂对接 |
|------|------|---------|-----------|
| **local** | 本地开发 | `localhost:3000` | 机芯厂商云测试环境或内网穿透 |
| **staging** | 联调/测试 | `api-staging.deda.example.com` | 机芯厂商云测试环境 |
| **production** | 正式用户 | `api.deda.example.com` | 机芯厂商云生产环境 |

**关键原则**：
- 机芯设备只连接机芯厂商云，不直接连接 deda-server。
- 机芯厂商云需要支持配置不同环境的 deda-server 地址（WebSocket/MQTT/HTTP）。
- 测试/生产数据库、Redis、MQTT topic 必须隔离。
- 禁止本地/测试环境连接生产数据库。

## 本地开发

### 1. 安装依赖

```bash
cd /Users/xiong/Desktop/deda-server
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写数据库、Redis、MQTT、微信、厂商 API 等配置
```

### 3. 启动基础设施（PostgreSQL + Redis）

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

### 6. 使用 Docker 启动完整本地环境（可选）

```bash
docker-compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up -d
```

该命令会挂载源码并启用热重载，适合需要 Nginx 反向代理或统一网络的场景。

## 生产部署（阿里云 ECS）

### 1. 准备服务器

- 购买阿里云 ECS（建议 2 核 4G 起步，CentOS/Ubuntu）
- 开放 80、443、3000 端口
- 安装 Docker 与 Docker Compose

### 2. 配置域名与 HTTPS

- 将域名（如 `api.deda.example.com`）解析到 ECS 公网 IP
- 使用 Certbot 申请 Let's Encrypt 证书
- 生产 Nginx 配置位于 `nginx/nginx.prod.conf`，需替换为真实域名与证书路径

### 3. 配置环境变量

```bash
cp .env.example .env
# 填写生产环境配置（数据库、Redis、MQTT、微信、厂商 API、JWT 等）
```

### 4. 构建并启动

```bash
docker-compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --build
```

### 5. 查看日志

```bash
docker logs -f deda-server-prod
```

## 测试环境部署（Staging）

测试环境用于与机芯厂商云联调，以及小程序真机预览/体验版调试。

```bash
# 1. 准备独立服务器或 ECS
# 2. 域名解析 api-staging.deda.example.com
# 3. 配置 .env.staging（独立数据库、Redis、MQTT、厂商测试环境地址）
# 4. 启动
docker-compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml --env-file .env.staging up -d --build
```

**机芯调试**：让机芯厂商云测试环境连接 `wss://api-staging.deda.example.com/vendor` 和 `api-staging.deda.example.com` 的 MQTT/HTTP 地址。

**小程序调试**：在微信开发者工具中关闭“校验合法域名、web-view 域名、TLS 版本以及 HTTPS 证书”可进行本地 API 调试；真机预览/体验版需将 `api-staging.deda.example.com` 配置为合法域名。

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

- 当前已实现 WebSocket 文字通道、MQTT 设备状态订阅、设备绑定/解绑/列表、4G 预绑定对话恢复、健康检查等核心能力；控制类接口（音量、开关机、WiFi 下发等）为桩实现，需与机芯厂商联调时填充。
- 厂商 API 基地址、微信小程序 AppID/Secret、MQTT broker 地址等敏感信息通过环境变量注入，不要提交到代码仓库。
- MQTT 消息按 `messageId` 做进程内幂等去重，生产多实例部署时建议改用 Redis Set。
- Webhook 接收接口建议配合 Redis 做幂等校验与流量缓冲。
