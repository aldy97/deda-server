# 冒险故事短片（54–58 秒）

状态：后端已实现，未上线。开关 `ADVENTURE_VIDEO_ENABLED=false` 默认关闭。

## 1. 范围

- 输入：冒险内容工作台里**当前发布版本**（`AdventureEpisodeVersion`）。
- 输出：54–58 秒、9:16、720×1280（可配 1080P）、H.264/AAC 的 MP4。
- 内容：纯叙事；最多一处角色提问；不含二选一互动。
- 画面：`wan3.0-video`，2 段以内、每段 ≤30 秒，`audio=false`。
- 配音：CosyVoice；默认 `VIDEO_TTS_MODE=system` 试跑，样本到位后切 `cloned`。
- 分镜导演 prompt：已进 prompt-registry（key `adventure_video_storyboard_system`，
  分类 `adventure_video`），可在看板 `/prompts` 热改，发布后最长 60 秒生效。

## 2. 架构

```
dashboard 抽屉「短视频」tab
      │ POST /analytics/adventure-video/jobs
      ▼
adventure-video（API 模块）── 建单/查单/重试/取消、预算闸、审计
      ▼ DB 队列（status=queued）
video-worker（独立容器）
      分镜(LLM) → TTS → 量时长 → 暂停待审核 →（批准后）切段 → wan3.0 → ffmpeg 合成 → OSS
```

API 镜像不装 ffmpeg；worker 用 `docker/Dockerfile.worker`（含 ffmpeg + Noto CJK）。

## 3. 数据表（全部新增，零改动既有表）

| 表 | 用途 |
|---|---|
| `adventure_video_jobs` | 作业、阶段、成本、storyboard、错误 |
| `adventure_video_shots` | 每段视频的 prompt/seed/任务 id（预留逐段重跑） |
| `adventure_video_assets` | OSS 产物索引（音频/片段/成片/SRT） |
| `adventure_video_voices` | 三条复刻音色（样本到位前为空） |

迁移 `20261128120000_adventure_video` 只有 `CREATE TABLE/INDEX` 与**新表**外键；
`20261128142917_adventure_video_storyboard_review` 给作业表加审核字段（见第 7 节）。

## 4. 环境变量

见 `.env.example` 的「冒险短视频」段。要点：

- `ADVENTURE_VIDEO_ENABLED`：总开关，必须显式 `true`。
- `VIDEO_TTS_MODE`：`system` / `cloned`。
- `VIDEO_TTS_INSTRUCTION`：默认 `on`；`off` 是紧急止血开关，强制所有档位都不下发
  `instruction`。只有 `cloned`（cosyvoice-v3.5-flash 复刻音色）真正会带情绪指令：
  v3-flash 的三个系统试跑音色在官方音色表里标注「Instruct：不支持」，带指令会被
  上游以 428 拒绝。
- `VIDEO_REFERENCE_KEYS`：`{"elly":"adventure-video/refs/elly.png","polly":"..."}`，
  缺省则不带参考图出片（角色一致性会明显下降）。
- `BAILIAN_API_KEY` / `BAILIAN_WORKSPACE_ID`：必须同属华北2。
- `OSS_*`：私有桶；视频不落 `app-assets` 图床。
- compose 的 `app` 与 `video-worker` 两个 service 都要转发这些键（见
  `docker/docker-compose.yml` 白名单）。

## 5. OSS 就绪检查

```bash
export OSS_REGION=cn-beijing OSS_BUCKET=... \
       OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=...
npm run check:oss
```

必检项与判定：

| 检查 | 期望 |
|---|---|
| `bucket.region` | 等于 `OSS_REGION`（建议 `oss-cn-beijing`，与百炼同区） |
| `bucket.private` | ACL = `private` |
| `object.put` | 上传测试对象成功 |
| `anonymous.denied` | 不带签名 GET = 403（公共读会红） |
| `signed.get` | 签名 URL = 200 |
| `signed.range` | `Range: bytes=0-7` = 206（视频可拖动） |
| `object.list` | 前缀可列举（生命周期清孤儿依赖） |
| `signed.expired` | 非必检；过期后 403 |

退出码 0 全绿、1 有必检失败、2 缺配置。测试对象自动删除。

## 6. 音色（TODO）

1. 准备 `local-assets/voices/{elly,polly,narrator}.wav|mp3|m4a`：
   10–20 秒、≥16kHz、无 BGM/其他人声、≤10MB。
2. `npm run clone:video-voices -- --dry-run` 先看参数。
3. 去掉 `--dry-run` 执行：创建音色、等待 `OK`、写入 `adventure_video_voices`。
4. 部署配置改 `VIDEO_TTS_MODE=cloned`，新作业即用复刻音色；
   旧作业的 `voiceSetVersion` 不同，不会被误复用。
5. 合规：只复刻有书面授权的音色；授权文件不入库。

系统试跑音色（仅联调）：Elly=`longhua_v3`、Polly=`longze_v3`、旁白=`longwan_v3`。
这三个音色官方标注 Instruct 不支持，因此 `system` 档不带情绪指令（全片一条语调）；
要情绪弧线需切 `cloned`（v3.5-flash 复刻音色支持自由中文指令）。

## 7. 接口

```
GET  /analytics/adventure-video/capabilities
POST /analytics/adventure-video/jobs            {episodeId, episodeVersionId, requestId, reason}
GET  /analytics/adventure-video/jobs?episodeId=
GET  /analytics/adventure-video/jobs/:id
POST /analytics/adventure-video/jobs/:id/retry  {reason}
POST /analytics/adventure-video/jobs/:id/cancel {reason}
GET  /analytics/adventure-video/jobs/:id/preview-url
GET  /analytics/adventure-video/jobs/:id/download-url
POST /analytics/adventure-video/jobs/:id/storyboard/validate   {storyboard}
PUT  /analytics/adventure-video/jobs/:id/storyboard            {storyboard, expectedRevision, reason?}
POST /analytics/adventure-video/jobs/:id/storyboard/revoice    {expectedRevision, reason}
POST /analytics/adventure-video/jobs/:id/storyboard/regenerate {expectedRevision, reason}
POST /analytics/adventure-video/jobs/:id/storyboard/approve    {expectedRevision, reason}
```

- 只允许**当前发布版**；草稿、历史版本、已下架一律拒绝。
- `requestId` 幂等：同一次弹窗重复点击返回同一 job；主动重新生成换新值。
- 审计写 `adventure_content_audit_logs`：`video_generate / video_retry / video_cancel / video_storyboard_edit / video_storyboard_revoice / video_storyboard_regenerate / video_storyboard_approve`。
- 状态：`queued → running(storyboard/voice) → awaiting_review → queued → running(visual/assemble/upload) → succeeded | failed | canceled`。
- 审核门在 TTS 之后、视频之前：`awaiting_review` 不参与 `claimNext`，批准前不会调用视频模型。
- 编辑只允许改每个 beat 的 `text / shot / visualPrompt / emotion / optional`；beat 数量、顺序、`speaker`、`characters`、`sourceSegmentOrders` 锁定，结构不对走 `regenerate`。
- 审批硬闸：TTS 实测 54–58 秒、单段 ≤30 秒、`voiceTextHash` 与当前文案一致；不满足返回 409。
- `preview-url` 与 `download-url` 都是现签；下载地址带 `content-disposition: attachment`，TTL 以 `expiresInSec` 为准。
- 审核写操作在 staging 与 prod 的 superadmin 都开放（`@VideoReviewWrite()` 只豁免环境 profile 闸，身份闸仍是 SuperAdminGuard + ContentAdminGuard）。

## 8. 成本与预算

按列表价（元）：

- 视频：480P 0.3、720P 0.6、1080P 1.2 元/秒；60 秒 720P ≈ 36 元（活动折扣以账单为准）。
- TTS：system 1 元/万字符，cloned 0.8 元/万字符。
- 参考图：0.18 元/张。

建单前按「60 秒 + 全部旁白字数 + 3 张图」预估；超过
`VIDEO_TEASER_BUDGET_CNY` 直接拒绝，不产生费用。

## 9. 错误码

| code | 含义 / 处置 |
|---|---|
| `VIDEO_STUDIO_DISABLED` | 开关未开 |
| `EPISODE_NOT_PUBLISHED` / `VERSION_NOT_CURRENT` | 只能对当前发布版生成 |
| `EPISODE_RETIRED` | 已下架 |
| `BUDGET_EXCEEDED` | 预估超预算 |
| `VOICE_NOT_READY` | cloned 模式但三条音色未齐 |
| `TTS_PARAMETER_INVALID` | TTS 参数被上游拒绝（如音色不支持 instruction 的 cosyvoice 428），message 带 voice/model；可先查 `VIDEO_TTS_INSTRUCTION`，再决定换音色 |
| `STORYBOARD_FORBIDDEN_WORD` | 分镜文案命中违禁词（baseline 见 `src/common/content/forbidden-words.ts`，env 只能追加），已重试一次仍失败 |
| `STORYBOARD_ENDING_REQUIRED` | 开端或结局 beat 被标 optional（三幕闭环不可裁剪），已重试一次仍失败 |
| `STORYBOARD_CHAR_BUDGET` / `STORYBOARD_CLIP_TOO_LONG` | 分镜超字数/超 30 秒 |
| `STORYBOARD_TOTAL_TOO_SHORT` / `STORYBOARD_TOTAL_TOO_LONG` | 分镜预估时长不在 54–58 秒 |
| `STORYBOARD_STRUCTURE_LOCKED` | 审核稿改了锁定的 beat 结构 |
| `STORYBOARD_CONFLICT` | `expectedRevision` 落后，先刷新 |
| `JOB_NOT_REVIEWABLE` | 当前状态不是 `awaiting_review` |
| `VOICE_STALE` / `VOICE_ASSET_MISSING` | 文案改过但音频未重配 / 已审批音频丢失，需 revoice |
| `VOICE_TOO_SHORT` / `VOICE_TOO_LONG` | TTS 实测不在 54–58 秒，带 `actualSec` |
| `OVER_BUDGET`（clip planner） | 真实配音超 58 秒且无 optional 可丢 |
| `TASK_TIMEOUT` / `TASK_FAILED` | 视频任务失败，可 retry |
| `BINARY_NOT_FOUND` | worker 镜像缺 ffmpeg |
| `OSS_NOT_CONFIGURED` | OSS 四项配置不全 |
| `STALE_TIMEOUT` | worker 心跳超 10 分钟，重试 3 次后失败 |

## 10. 运维

- 迁移：`npx prisma migrate deploy --schema=src/prisma/schema.prisma`（只跑一次，API 容器启动会做）。
- worker：`docker compose --profile video ... up -d video-worker`；默认 profile 不启动它，
  显式加 `--profile video` 才拉起；`ADVENTURE_VIDEO_ENABLED=false` 时只打日志不轮询。
- staging 容器名：`deda-server-video-worker-staging`（`docker-compose.staging.yml` 覆盖）；
  base compose 的 `deda-server-video-worker` 留给 prod/历史容器，避免 Docker name 冲突。
- staging 自动构建：push `staging` 时，Deploy Staging 只在 diff 命中 worker 运行面
  （`.github/worker-trigger-paths.json`，含 `src/video-worker/**`、`adventure-video`、prompt-registry、
  llm、prisma schema 等）才构建/传输 worker 镜像并 `--profile video` 拉起；纯 API 侧模块
  （mqtt、device-configs、dashboard 路由…）与前端改动不触发。改了服务器 `env/.env.staging`
  里的 `VIDEO_*` 需要重载时，手动 `workflow_dispatch` 一次（`force_worker` 默认 true）。
  新增 worker 依赖若未同步清单，`worker-trigger-gate.spec.ts` 会让 CI 变红。
- 并发：`VIDEO_WORKER_CONCURRENCY`（默认 2）；可灵系列 10 并发是账号级共享，别开太大。
- 中间产物：`adventure-video/jobs/...`，建议生命周期 14 天；`final/` 长期保留。
- 待审核作业（`awaiting_review`）不参与心跳回收，也不会自动通过；看板会显示等待时长，需 superadmin 处理。
- 审核写操作在 prod 也开放，但只限 `@VideoReviewWrite()` 标注的 5 个分镜路由；其他冒险内容写操作仍受 `CONTENT_ADMIN_PROFILE=authoring` 限制。
- 紧急止血：把 `ADVENTURE_VIDEO_ENABLED` 改回 false 并重启 app + worker；
  已提交的远端任务无法撤回，靠 OSS 生命周期清理孤儿产物。

## 11. 验收清单

- [ ] `npm run test:cov` 全绿，`adventure-video` 新代码行覆盖 ≥90%
- [ ] `npm run check:oss` 必检项全绿
- [ ] 选一集已发布故事，生成出 54–58 秒 MP4
- [ ] 首次跑完停在 `awaiting_review`，不调用视频模型；编辑/校验/重新配音/审批全链路可用
- [ ] 审批时故意改短文案不重配 → 409 `VOICE_STALE`；实测不足 54 秒 → 409 `VOICE_TOO_SHORT`
- [ ] staging 与 prod 的 superadmin 都能编辑/审批（prod 其他内容写操作仍只读）
- [ ] 预览 URL 过期后播放器 onError 自动换签，下载按钮点击时现签
- [ ] `ffprobe`：720×1280、30fps、有音轨
- [ ] 无 >1.5 秒意外静音、无 >0.3 秒黑帧
- [ ] 字幕无方块（镜像已装 Noto CJK）
- [ ] 实际成本与预估偏差 ≤10%
- [ ] 重复点击不重复扣费；失败 retry 复用同一 job
