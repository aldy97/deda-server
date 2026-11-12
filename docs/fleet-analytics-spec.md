# Fleet Analytics 接口规范

> 实现：`src/modules/analytics/fleet.controller.ts` + `fleet.service.ts`
> 路由前缀：`/analytics/fleet/*`，全部 GET。
> 鉴权：`AnalyticsAuthGuard`（JWT `scope === "analytics"`）。
> 统一信封：`{ code, message, data }`，`code = 0` 成功。

日期参数一律 `YYYY-MM-DD`（Asia/Shanghai 自然日）。字段命名 camelCase。时间字段 ISO 8601（除 `realtime.lastSeenAt` 为 epoch 毫秒）。

## 全局口径

两个口径不可互相校验，前端须分开标注：

- **实时口径**：`onlineNow` / `realtime.online` — Redis `device:link:{MAC}` 的 `lastSeenAt` 落在 **15 秒**窗口内。
- **天级口径**：`devicesPoweredOn` / `presenceDays7d` / `presence[]` — `device_presence_daily` 表。
  落库点是 `DeviceLinkService.handleDeviceUp`（设备心跳旁路）：进程内按 5 分钟聚合，批量 flush 成一天一行，
  `reportCount` = 当日落库的心跳聚合次数，不是原始心跳条数。
- **`null` 表示「无数据」，`0` 表示「真的是零」**，语义不同，前端不得把 `null` 渲染成 `0`。
  早于 `presenceSince`（`device_presence_daily` 表内最小 `date`）的日期，天级指标一律 `null`；
  `presenceSince` 为 `null`（表为空 / 功能未上线）时，所有天级指标一律 `null`。
- **低电量阈值固定为 20**：`battery <= 20` 且**仅统计在线设备**；`battery` 为 `null` 的设备不计入。

---

## 1. GET /analytics/fleet/summary

Query：`date`（可选，缺省 = 昨天 T-1）。非法日期 → 400。

```json
{
  "date": "2026-11-11",
  "totalDevices": 28,
  "activatedDevices": 12,
  "devicesPoweredOn": 7,
  "powerOnRate": 0.5833,
  "onlineNow": 3,
  "lowBatteryNow": 1,
  "lowBatteryThreshold": 20,
  "presenceSince": "2026-11-12"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalDevices` | number | 全量设备数，`where createdAt < 当日 end` |
| `activatedDevices` | number | `userDeviceBinding` distinct deviceId 计数 |
| `devicesPoweredOn` | number\|null | 当日 `device_presence_daily` 行数；早于 presenceSince → null |
| `powerOnRate` | number\|null | `devicesPoweredOn / activatedDevices`，4 位小数；分母 0 或分子 null → null |
| `onlineNow` | number\|null | 实时口径；Redis 查询失败 → null |
| `lowBatteryNow` | number\|null | 在线且 `battery <= 20` 的台数；Redis 查询失败 → null |
| `lowBatteryThreshold` | number | 常量 20，回显给前端渲染文案 |
| `presenceSince` | string\|null | `device_presence_daily` 最小 date；表为空 → null |

---

## 2. GET /analytics/fleet/presence-trend

Query：`startDate`、`endDate`（必填，`startDate <= endDate`，否则 400）。区间上限 **62 天**，超出 → 400。

```json
{
  "startDate": "2026-10-13",
  "endDate": "2026-11-11",
  "presenceSince": "2026-10-20",
  "series": [
    {
      "date": "2026-10-13",
      "devicesPoweredOn": null,
      "powerOnRate": null,
      "reportCount": null
    },
    {
      "date": "2026-10-20",
      "devicesPoweredOn": 0,
      "powerOnRate": 0,
      "reportCount": 0
    }
  ]
}
```

- 区间内每一天都出现（无数据日按规则补 `null` 或 `0`，不缺日），按 `date` 升序。
- `powerOnRate` 分母 = 截至该日的累计已激活设备数（`userDeviceBinding.createdAt < 该日 end` 的 distinct deviceId），不是区间末快照；分母为 0 → `null`。
  实现上按设备取**最早一次绑定时间**（`groupBy` + `_min(createdAt)`）：`distinct` 不保证挑到哪一行，
  一台设备被多人绑定时会把激活日算晚。
- 只支持日粒度，无 `granularity` 参数。

---

## 3. GET /analytics/fleet/firmware-distribution

Query：无（统计当前全量在册设备）。

```json
{
  "total": 28,
  "buckets": [
    { "firmwareVersion": "unknown", "devices": 24 },
    { "firmwareVersion": "1.2.3", "devices": 4 }
  ]
}
```

- `Device.firmwareVersion` 为 `null` **或空字符串**时归入 `"unknown"` 桶。
- 排序：`devices` 降序；数量相同时按 `firmwareVersion` 升序（`"unknown"` 视为最大，排最后）。
- `buckets` 内 `devices` 之和恒等于 `total`。

---

## 4. GET /analytics/fleet/churn-risk

Query：`days`（可选，缺省 **7**，允许范围 **1–90**，越界 → 400）。

```json
{
  "days": 7,
  "asOf": "2026-11-12",
  "count": 3,
  "devices": [
    {
      "deviceId": "aabbccddeeff",
      "characterKey": "elly",
      "firmwareVersion": null,
      "lastActiveAt": "2026-11-01T08:12:33.000Z",
      "daysInactive": 11,
      "basis": "presence"
    }
  ]
}
```

- 只返回 `daysInactive >= days` 的设备，按 `daysInactive` **降序**；无风险设备时 `devices` 为 `[]`。
- `lastActiveAt` 取值优先级：
  1. `device_presence_daily.lastSeenAt` 最大值（`basis = "presence"`）
  2. 若无 presence 记录，取 `messages.spokeAt` 最大值（`basis = "message"`）
  3. 若两者都无，取 `device.createdAt`（`basis = "createdAt"`）
- `daysInactive` = `asOf` 与 `lastActiveAt` 之间的自然日差（Asia/Shanghai，向下取整，最小 0）。
- 不设分页/上限。

---

## 5. GET /analytics/fleet/devices

Query：
- `keyword`（可选，最长 **50** 字符，超出 → 400）：对 `deviceId` / `deviceCode` / `macAddress` 做 Prisma `contains` 参数化匹配（不区分大小写，`mode: "insensitive"`）。
- `page`（可选，缺省 1，最小 1）
- `pageSize`（可选，缺省 **20**，最小 1，最大 **100**）— 超过 100 静默 clamp 到 100。

```json
{
  "page": 1,
  "pageSize": 20,
  "total": 28,
  "items": [
    {
      "deviceId": "aabbccddeeff",
      "deviceUuid": "550e8400-e29b-41d4-a716-446655440000",
      "characterKey": "elly",
      "deviceCode": null,
      "firmwareVersion": null,
      "macAddress": "aabbccddeeff",
      "createdAt": "2026-10-01T02:11:09.000Z",
      "boundUsers": 1,
      "realtime": {
        "online": true,
        "battery": 80,
        "volume": 50,
        "version": "1.2.3",
        "charging": false,
        "lastSeenAt": 1794488070083
      },
      "presenceDays7d": 5,
      "lastPresenceDate": "2026-11-11",
      "turns7d": 12
    }
  ]
}
```

- 排序固定 `createdAt` 降序（不接受 sort 参数）。
- `realtime` 判定：`DeviceLinkService.getStatusBatch` 返回的条目若 `lastSeenAt === null` 视为「无 Redis 记录」→ `realtime: null`；整个批量查询抛错时所有 item 的 `realtime` 都为 `null`（不得因此 500）。
- MAC 口径：`getStatusBatch` 返回的 Map 以**归一化大写 MAC**（去分隔符）为 key，而 Prisma 侧 `macAddress` / `deviceId` 存的是小写。
  查询时传库里的原值 `device.macAddress ?? device.deviceId`，但**读 Map 必须先做同样的归一化**（见 `fleet.service.ts` 的 `normalizeMac`），否则全量 miss、`realtime` 恒为 `null`。
- 只在 DB、Redis 无 key 的设备仍必须出现在列表里（`realtime: null`、`presenceDays7d: 0`）。

---

## 6. GET /analytics/fleet/devices/:deviceId

Path：`deviceId` = 业务 ID（小写 MAC），不是内部 UUID。查不到 → 404（不得返回空壳对象）。

存量数据里 `deviceId` 大小写混用，故查找顺序为：**精确匹配优先 → 未命中再做大小写不敏感兜底**
（`findFirst` + `mode: "insensitive"`）。这样列表接口返回的 `deviceId` 原样回传也能查到；
两者都未命中才 404。**不要**把入参直接 `toLowerCase()` 后做精确匹配 —— 那会让库里存大写的设备永远 404。

Query：`days`（可选，缺省 **30**，范围 1–90，越界 → 400）— 控制 `presence` 与 `dailyTurns` 的回看天数。

```json
{
  "deviceId": "aabbccddeeff",
  "deviceUuid": "550e8400-e29b-41d4-a716-446655440000",
  "characterKey": "elly",
  "deviceCode": null,
  "firmwareVersion": null,
  "macAddress": "aabbccddeeff",
  "wifiName": null,
  "ipAddress": null,
  "networkType": null,
  "timezone": null,
  "createdAt": "2026-10-01T02:11:09.000Z",
  "realtime": {
    "online": true,
    "battery": 80,
    "volume": 50,
    "version": "1.2.3",
    "charging": false,
    "lastSeenAt": 1794488070083
  },
  "boundUsers": [
    { "userId": "fb8f69f4-dfcf-40cb-a0fa-a21e35e2c4d4", "isOwner": true, "boundAt": "2026-10-02T09:00:00.000Z" }
  ],
  "presence": [
    { "date": "2026-11-10", "reportCount": 288, "firstSeenAt": "2026-11-10T00:00:05.000Z", "lastSeenAt": "2026-11-10T23:59:58.000Z" }
  ],
  "dailyTurns": [
    { "date": "2026-11-10", "turns": 12 }
  ],
  "totals": { "presenceDays": 5, "turns": 63 }
}
```

- `boundUsers` 只暴露 `userId`（UUID）+ `isOwner` + `boundAt`，不得返回昵称、openid、手机号等 PII。
- `presence`：近 days 天，按 date 升序；无行的日期不补（前端自行渲染日历断点）。
- `dailyTurns`：近 days 天，按 date 升序，无消息日补 0（长度为 days 固定）。
- `dailyTurns` 的 `turns` = `messages` 中 `role = "user"` 且 `spokeAt` 落在该 Asia/Shanghai 自然日的条数。注意 `Message.deviceId` 存的是内部 UUID。

---

## 前端对接要点

- 全部 6 个接口走既有 analytics token（`sessionStorage['deda_dashboard_token']`）。
- `realtime.lastSeenAt` 是 **epoch 毫秒数字**，不是 ISO 字符串（透传 Redis 原值）；其余时间字段都是 ISO 8601 字符串。
- 渲染 `null` 一律显示 `-`，**不要**用 `?? 0`。
- 实时卡片与天级卡片必须分别标注口径（例：「实时在线（15 秒窗口）」vs「当日开机（天级）」）。