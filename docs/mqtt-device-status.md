# 设备在线状态与电量/充电显示 — 后端开发文档（MQTT 链路）

版本：v1.1（2026-11-11，staging 已落地验证）
读者：后端开发 / 联调工程师
关联文档：`docs/vendor-mqtt-protocol.md`（机芯厂 MQTT 协议）、`docs/vendor-http-onboarding.md`（机芯厂 HTTP 上线）

---

## 1. 背景与目标

小程序设备列表/详情页需要展示设备真实状态：**在线/离线、电量、充电状态、最后活跃时间**。

链路：设备 → MQTT broker → deda-server（device-link 模块）→ Redis 状态缓存 → 小程序 `GET /devices/{id}/status`。

## 2. 现状盘点（截至 2026-11-11，staging 实测）

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| device-link 模块（订阅/缓存/在线判定） | ✅ 已实现 | `src/modules/device-link/`，含 spec |
| `GET /devices/{id}/status` HTTP 接口 | ✅ 已实现 | `devices.service.status()`，读 Redis 惰性计算在线 |
| 小程序展示层（列表/详情） | ✅ 已接好 | status/battery/isCharging 字段全部就位，零改动 |
| MQTT broker | ✅ 已部署（staging） | `deda-mqtt-staging` 容器（eclipse-mosquitto:2），强制账密认证；公网 1883 待安全组放行 |
| 充电状态（isCharging） | ✅ 服务端已支持 | device-link 合并 `charging`、status 接口透传；机芯厂 v1.1 契约为 `boolean \| null`，当前固件恒发 `null`，服务端保留上一次已知值 |
| 音量（volume）读取 | ✅ 已暴露 | `status()` 返回 `volume`，取自 `query` 心跳；供音量控制页显示设备真实音量、并在下发后回读确认生效 |

## 3. 机芯厂协议约束（硬约束，不可违反）

来源：《设备端 MQTT 对接文档》v1.1。以下是与本功能相关的约束全集：

**连接参数**

| 参数 | 值 | 约束 |
| --- | --- | --- |
| Broker | **由我方（服务端）提供** | 需公网可达，当前 staging 为 `8.133.236.127` |
| ClientID | 设备 MAC | 12 位无分隔小写十六进制 |
| KeepAlive | 30s | TCP 层保活，不代替应用层心跳 |
| CleanSession | false | 持久会话 |
| QoS | 1 | 至少一次 |
| 认证 | 用户名/密码 | **公网环境强制开启**（`allow_anonymous false`），账号密码经安全渠道交付 |

**主题与消息**

- 上行（设备→服务端）：`device/up/{mac}`；下行（服务端→设备）：`device/down/{mac}`
- `{mac}` 必须与 HTTP loginMac 的 mac 完全一致（无分隔十二位小写十六进制）
- 消息一律 UTF-8 JSON 信封：`{ "cmd": string, "flag": "success"|"fail", "data": object|null }`
- 命令字：`query`（状态上报/查询）、`volume`、`restart`、`upgrade`、`recover`

**心跳与在线判定**

- 设备每 **5 秒**上报一次 `query` 心跳（即使无变化也必须报）
- 服务端判定：**15 秒内**（3 倍心跳）有上报 = 在线，否则离线；恢复上报自动转在线
- `query.data`：`{ battery: 0-100, volume: 0-100, version: "x.y.z", charging: boolean | null }`
  （`charging` 为 2026-11-11 约定增补，机芯厂 v1.1 已按 `boolean | null` 上报，当前固件恒发 `null`；
  服务端对 `null` 与字段缺失同口径处理——保留上一次已知值）

## 4. 总体架构

```
设备 ──MQTT(device/up/{mac}, 5s 心跳)──▶ mosquitto(broker, :1883)
                                            ▲
                                            │ subscribe device/up/+
                                     deda-server device-link
                                            │ mergeStatus → Redis
                                            │   key: device:link:{MAC}  TTL 3600s
                                            ▼
小程序 ◀── GET /devices/{id}/status ── devices.service.status()
              { status, battery, isCharging, lastActiveAt }
              online = now - lastSeenAt ≤ 15000ms（读取时惰性计算）
```

要点：

- **在线状态不落库**，以 Redis `lastSeenAt` + 15s 窗口惰性计算，与协议 7.2 节等价
- Redis 状态 TTL 3600s：设备离线后仍保留最近一次已知电量/音量供展示，`status` 字段单独判定
- 音量下发（`POST /devices/{id}/control` action=volume）已走 `device/down/{mac}`，本方案不影响
- Redis key 中 MAC 为**大写**（`normalizeMac` 归一化）；HTTP loginMac 链路用小写——两套口径并存是有意设计，勿混用
- **查 Prisma 一律用小写**：`Device.deviceId` / `macAddress` 均为十二位小写（`docs/integration.md`）。
  从 `device/up/{mac}` 提取的 MAC 是大写口径，落库前必须 `toLowerCase()`，否则 `updateMany`
  匹配 0 行且不报错（`firmwareVersion` 曾因此长期不落库，2026-11-12 修复，现 `count === 0` 会打 warn）

## 5. Broker 部署方案（mosquitto）

选型 **eclipse-mosquitto:2**：轻量（<20MB）、稳定、配置即文件；EMQX 的 dashboard/集群能力本阶段用不到。

**compose 改动（`docker/docker-compose.staging.yml`）**：

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    container_name: deda-mqtt-staging
    restart: always
    ports:
      - '1883:1883'   # 公网暴露，设备直连；安全组需放行 1883
    volumes:
      - /opt/deda/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - /opt/deda/mosquitto/passwordfile:/mosquitto/config/passwordfile:ro
    # 必须显式加入 deda-network：缺省会落到 default 网络，
    # app 将无法解析 mosquitto 主机名（2026-11-11 实踩）
    networks:
      - deda-network
```

**mosquitto.conf**（服务器 `/opt/deda/mosquitto/mosquitto.conf`）：

```conf
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwordfile
persistence false
log_dest stdout
```

**认证**：用户名/密码两个账号（设备侧、服务端侧可同账号），密码文件用 `mosquitto_passwd` 生成；密码进入 `env/.env.staging`，不入库不入镜像。

**环境变量（`env/.env.staging` 变更）**：

```bash
# 修复：容器内 127.0.0.1 是容器自身；改为 compose 网络内服务名
MQTT_URL=mqtt://mosquitto:1883
MQTT_USERNAME=deda
MQTT_PASSWORD=<32 位随机>
```

**`docker/docker-compose.yml` base 透传追加**：

```yaml
      MQTT_USERNAME: ${MQTT_USERNAME:-}
      MQTT_PASSWORD: ${MQTT_PASSWORD:-}
```

**`MqttService` 改动**：connect 选项加 `username`/`password`（env 有才携带，缺省匿名）。

**安全组（人工前置）**：阿里云控制台放行 1883/TCP 入方向 —— 无权限代操作，需账号持有者完成。

### 5.1 落地备忘（2026-11-11 实踩）

- **compose 操作口径必须与 CI 一致**：从 `/opt/deda` 执行并带 `-p deda-staging`：
  `docker compose -p deda-staging --env-file env/.env.staging -f docker/docker-compose.yml -f docker/docker-compose.staging.yml up -d`
  从 `docker/` 目录或不带 `-p` 执行会得到错误的 project 标签，compose 不认已有容器，报容器名冲突。
- **服务器本地构建当前不可用**：Docker Hub 镜像源拉不到 `node:20-alpine`。正常部署路径是 CI（runner 构建 + SSH 直传 `docker load`），不受此影响。本次 staging 验证采用一次性增量镜像：本地 `npm run build` 后基于在跑镜像 `FROM` + `COPY dist/ /app/dist/` 构建出 `deda-server:staging-mqtt-dev`；PR 合并后由 CI 正常覆盖，无需手工清理。

## 6. 后端改动清单（已全部完成并部署至 staging）

| 文件 | 改动 |
| --- | --- |
| `docker/docker-compose.staging.yml` | 新增 mosquitto 服务（见 §5，含 `networks: - deda-network`） |
| `docker/docker-compose.yml` | environment 透传 `MQTT_USERNAME` / `MQTT_PASSWORD` |
| `src/common/mqtt/mqtt.service.ts` | connect 支持 username/password；连接失败日志增强 |
| `src/modules/device-link/device-link.types.ts` | `DeviceQueryData` 增补 `charging?: boolean`；`DeviceLinkStatus` 增补 `charging: boolean \| null` |
| `src/modules/device-link/device-link.service.ts` | `mergeStatus` 合并 charging（布尔合并，语义同 battery） |
| `src/modules/devices/devices.service.ts` | `status()` 返回 `isCharging: link.charging`（替代固定 null） |
| 对应 `*.spec.ts` | 同步补：charging 上报→缓存→接口返回；未上报为 null；MQTT 认证透传 |
| `docs/vendor-mqtt-protocol.md` | §5.1 增补 `charging` 字段约定（机芯厂待实现） |
| `docs/mqtt-device-status.md` | 本文档 |

注意（AGENTS.md 约定）：本方案不动 Prisma schema、不动 JWT 守卫、不动统一响应信封；`GET /devices/{id}/status` 字段语义向后兼容（isCharging 由固定 null 变为可空布尔）。

## 7. 接口契约

### 7.1 对小程序（HTTP，已实现不变）

`GET /devices/{id}/status`，`{id}` 为业务 deviceId（MAC 形态，如 `90fe1de7a1ca`）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "deviceId": "90fe1de7a1ca",
    "status": "online",            // "online" | "offline"，15s 心跳窗口判定
    "battery": 80,                  // 0-100 | null（从未上报）
    "isCharging": true,             // true | false | null（设备未上报充电字段时为 null）
    "lastActiveAt": "2026-11-11T01:22:12.000Z"  // ISO 8601 | null
  }
}
```

约束：设备不存在返回 404（前端已按"已解绑"兜底）；offline 时 battery/isCharging 仍返回最近一次已知值。

### 7.2 对设备（MQTT，本次交付机芯厂）

- Broker：`mqtt://8.133.236.127:1883`，用户名/密码单独安全渠道交付
- ClientID = MAC；CleanSession=false；KeepAlive=30s；QoS=1
- 连接后：订阅 `device/down/{mac}` → 立即上报一条 `query` → 每 5s 心跳
- `query.data` 期望扩展为：

```json
{ "battery": 80, "volume": 50, "version": "1.2.3", "charging": false }
```

- 断线重连后恢复订阅与心跳；无需重复 HTTP 上线（API KEY 仍有效时）

## 8. 外部依赖

| 依赖 | 责任方 | 状态 |
| --- | --- | --- |
| 安全组放行 1883/TCP | 熊总 | ⏳ 待办（阿里云控制台入方向规则） |
| charging 字段上报 | 机芯厂 | ⏳ 待固件实现；未上前接口为 null，不阻塞上线 |
| 设备连接参数 | 我方→机芯厂 | ⏳ 待交付（broker 地址/端口/账号密码，安全渠道） |

## 9. 测试与验收

**自动化（deda-server）** — ✅ 已完成（51 套件 / 830 用例全绿）

- device-link spec：query 带 charging → Redis 缓存合并 → getStatus 返回；不带 charging → null 保持
- devices status spec：online/offline 边界（lastSeenAt ±15s）、404、charging 透传
- mqtt service spec：env 提供 username/password 时透传给连接选项

**联调验收（staging，2026-11-11 实测）**

1. ✅ `docker logs deda-server-staging` 出现 `MQTT connected to mqtt://mosquitto:1883`，client error 消失
2. ✅ 模拟设备上报（`mosquitto_pub` 容器内 localhost）写入 Redis `device:link:90FE1DE7A1CA`（含 charging）；匿名连接被拒（`not authorised`）
3. ✅ 心跳窗口内 `GET /devices/90fe1de7a1ca/status` 返回 `online` + `battery=80` + `isCharging=true`；无 token 返回 401
4. ✅ 停止上报 20s 后同接口返回 `offline`，battery/isCharging 保留最后已知值
5. ⏳ 真机：安全组放行后，机芯厂设备接入 broker，小程序列表/详情页显示在线与电量

## 10. 落地顺序（Checklist）

1. [ ] 熊总：阿里云安全组放行 1883/TCP
2. [x] 后端：deda-server 开分支（off staging），完成 §6 全部改动 + 测试
3. [x] 服务器：`/opt/deda/mosquitto/` 配置与密码文件就位，compose up，MQTT connected
4. [x] 模拟设备验证在线/离线翻转与字段透传
5. [ ] 交付机芯厂 broker 参数 + charging 字段约定
6. [ ] 真机复验，PR 合并部署
