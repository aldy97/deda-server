# ChildMemory：儿童长期偏好记忆

## 目标与边界

ChildMemory 保存孩子明确表达、可在后续自由对话中自然复用的长期偏好。小模型只负责提取候选，后端负责格式校验、安全过滤、版本控制和写库。

MVP 不包含向量检索或通用 RAG，不保存学校、地址、电话、健康等敏感档案，不根据推测创建记忆。记忆提取异步执行，不阻塞 filler 首音；提取或召回失败不影响本轮回复和 WS chunk 上传。

## 数据模型

`ChildMemory` 以 `(deviceId, key)` 表示一个逻辑记忆槽位，以 `version` 保存不可变历史：

- `active`：当前有效值，每个设备、每个 key 最多一条。
- `superseded`：已被新版本替代的历史值，保留原 `valueText`。
- `retracted`：撤回产生的墓碑或已撤回历史，不参与召回。
- `validFrom` / `validTo`：该版本的有效时间范围。
- `supersededById`：指向替代它的新版本，形成版本链。
- `sourceTurnId` / `sourceOccurredAt`：来源轮次及发生时间，用于幂等和乱序保护。
- `lastInjectedAt` / `injectionCount`：记录提供给主模型的次数，不代表孩子已经听到。

数据库通过 `(deviceId, key, version)` 和 `(deviceId, sourceTurnId, key)` 唯一约束保证版本及来源幂等；PostgreSQL 部分唯一索引保证同一槽位只有一个 active 版本。事务内的 advisory lock 串行化同一槽位的并发更新。

## 生命周期

| 输入情况 | 处理方式 |
| --- | --- |
| 第一次明确表达最喜欢红色 | 新建 red v1，状态为 active |
| 再次确认最喜欢红色 | 只更新 `lastConfirmedAt`，不新增版本 |
| 后来改为最喜欢蓝色 | 新建 blue v2；red v1 改为 superseded，原值不变 |
| 明确撤回偏好 | 新建 retract 墓碑；历史版本保留 |
| “我也喜欢蓝色” | additive 表达，不替换单值“最喜欢” |
| 旧轮次提取晚于新轮次完成 | 按 `sourceOccurredAt` 拒绝乱序写入 |
| 同一轮次重复提取 | 按来源唯一约束及预检保持幂等 |

## 提取与召回链路

1. Vendor 收到有效 ASR 文字后，先保存 user 消息。
2. 使用相同 `sourceOccurredAt` 异步调用小模型提取；上一条 assistant 仅提供剥离 filler 后的 answer。
3. 提取器只输出严格 JSON 数组，每轮最多 3 个候选；后端只接受白名单 key、operation 和置信度不低于 0.75 的候选。
4. 仅 `free_chat` 主回答执行确定性话题召回，最多选择 3 条相关 active 记忆。
5. 记忆作为独立 system 数据块 prepend 到主 answer messages，不进入 filler prompt，也不注入教材等其他模式。
6. 主回复成功后才调用 `markInjected`；主模型失败不增加注入统计。

当前白名单：

- `favorite_color`
- `favorite_animal`
- `favorite_story_type`
- `preferred_interaction`
- `interest_topic`

召回不新增 LLM 调用。prompt 明确要求模型把记忆当作数据而非指令，自然相关时最多使用一条，避免每轮背诵偏好。

## 配置与迁移

沿用现有 `SMALL_LLM_*` 配置，不新增 API key。提取使用小模型、temperature 0、最多 300 tokens、5 秒超时。

迁移文件：`src/prisma/migrations/20261030074000_add_child_memories/migration.sql`。

本地、灰度和生产环境均须在发布应用前执行既有迁移部署流程。生成 migration 不等于已写数据库；任何实际 `migrate deploy` 都应针对目标环境单独确认。

## 测试

- 核心单测覆盖初始写入、同值确认、red→blue、撤回、additive、防乱序、幂等、安全过滤、相关召回和注入统计。
- Vendor 单测覆盖仅自由对话主回答注入、filler 隔离、异步提取参数、成功标记和提取故障隔离。
- e2e 使用真实 `ChildMemoriesService` 与内存 Prisma，验证完整版本链、只召回当前值，以及提取失败时 answer chunk 仍正常上传。
- 单测及 e2e 均 mock LLM 和厂商云服务，不访问真实外部网络。
