# 部署文档（阿里云 ECS）

本文档描述 deda-server 的 CI/CD 部署架构、服务器初始化、回滚与运维操作。

## 1. 架构总览

```
GitHub push
  ├─ staging 分支 → Deploy Staging workflow ─┐
  └─ main 分支    → Deploy Production workflow ┤
                                                ▼
                              Actions 构建镜像（不用镜像仓库）
                                                ▼
              镜像经 SSH 直传 ECS（docker save | ssh | docker load）
                                                ▼
                              ECS 上 docker compose up -d
                                                ▼
        ┌──────────────────────── ECS（一台，4G 内存）────────────────────────┐
        │  project deda-staging:  app(0.0.0.0:3001) + postgres + redis        │
        │  project deda-prod:     app(127.0.0.1:3000) + postgres + redis      │
        │  nginx(80/443)：备案完成后启用，反代两个环境                          │
        └──────────────────────────────────────────────────────────────────┘
```

- **两个环境完全隔离**：独立容器、独立数据卷、独立数据库，staging 的 migration 不会污染生产库。
- **镜像即制品**：每次部署对应唯一 tag（`staging-<sha>` / `prod-<sha>`），回滚 = 换 tag 重新部署。
- **worker 镜像按需构建**：staging 部署只在 diff 命中 worker 运行面（`.github/worker-trigger-paths.json`）时
  构建/传输 `deda-server-video-worker:staging-<sha>` 并以 `--profile video` 拉起容器；纯 API 侧模块
  （mqtt、device-configs、dashboard 路由等）与前端改动不触发。清单完整性由
  `src/common/workflows/worker-trigger-gate.spec.ts` 的闭包守卫钉住；prod 暂未接入。
- **备案期间访问方式**：staging 走 `http://ECS公网IP:3001`（非标端口不受备案拦截）；生产仅监听回环，等备案完成。

## 2. 分支模型

仓库**默认分支为 `staging`**，日常开发与发布流程：

```
feature/xxx  ──PR──▶  staging  ──PR(发布)──▶  main
 (从 staging 切出)   (自动部署 staging 环境)   (自动部署生产环境)
```

| 分支 | 说明 | 触发 | 环境 |
| --- | --- | --- | --- |
| `feature/*` | 从 `staging` 切出；新 PR 默认 base 即 staging | PR → CI（不部署） | — |
| `staging` | 集成分支，merge 即部署 | push → ci.yml `deploy-staging` → deploy-staging.yml | `https://staging.valleyletters.com` |
| `main` | 发布分支，只接受来自 staging 的 PR | push → ci.yml `deploy-prod` → deploy-prod.yml（人工批准后执行） | `https://valleyletters.com`（HTTPS） |

- 两个分支的 push/PR 都会跑 CI（lint + tsc + build + 单测 + e2e）。
- **部署只有一个入口**：`deploy-staging.yml` / `deploy-prod.yml` 自身都不带 `push` 触发，只能被
  ci.yml 里 `needs: ci` 的 job 调用（或手动 `workflow_dispatch`）。「ci 没全绿就部署」这条路在配置
  层面不存在；口径由 `src/common/workflows/ci-deploy-gate.spec.ts` 钉住，改坏即 CI 红。
- **生产人工审批已开启**：`deploy-prod.yml` 声明 `environment: production`，仓库 Settings →
  Environments → `production` 已配 required reviewers。ci 全绿后 workflow 停在等待批准，
  审批动作与部署日志都留痕在该 environment 下。
- 两个部署 job 各自成 concurrency 组且 `cancel-in-progress: false`：新部署不会取消进行中的部署
  （取消等于把服务器留在半部署状态），只会排队；staging 与 prod 互不阻塞。
- **hotfix 规则**：紧急修复可走 `hotfix/xxx → main` 的 PR，合并后必须把 main 回合（back-merge）到 staging，否则下次发布会把 hotfix 冲掉。
- 建议给 `main` 和 `staging` 配分支保护（要求 PR 合入 + CI 通过），防止直接 push 绕过流程触发生产部署。

## 3. 服务器一次性初始化

以下操作在 ECS 上手动执行一次（假设 Alibaba Cloud Linux / Ubuntu，用户有 sudo）：

```bash
# 1. 安装 Docker（以官方脚本为例，或按阿里云文档）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 重新登录生效

# 2. 创建部署目录
sudo mkdir -p /opt/deda/env /opt/deda/backups && sudo chown -R $USER /opt/deda

# 3. 创建环境变量文件（内容模板见仓库 .env.example，填入真实值）
#    /opt/deda/env/.env.staging   —— DB_PASSWORD、JWT_SECRET、微信/LLM/机芯厂密钥等
#    /opt/deda/env/.env.prod      —— 与 staging 不同的密码和密钥
chmod 600 /opt/deda/env/.env.*
```

**阿里云控制台侧**：

1. ECS 安全组放行入方向：`3001`（staging，备案期间临时用）、`22`（SSH，建议限制来源 IP）。**不要**对公网放行 3000/5432/6379。
2. 为 GitHub Actions 创建专用 SSH 密钥对，公钥加入 ECS `~/.ssh/authorized_keys`。

**GitHub 仓库 Secrets**（Settings → Secrets and variables → Actions，建议配在 `staging` / `production` 两个 Environment 里）：

| Secret | 说明 |
| --- | --- |
| `ECS_HOST` | ECS 公网 IP |
| `ECS_USER` | SSH 登录用户 |
| `ECS_SSH_KEY` | SSH 私钥（ed25519 全文） |

**首次部署前**：从 main 建 staging 分支并推送（`git checkout -b staging main && git push -u origin staging`）。

## 4. 日常操作

### 手动部署 / 重启

镜像由 CI 直传到服务器（`docker images | grep deda-server` 可查看）。手动重启或切换到已存在的镜像版本：

```bash
cd /opt/deda
# staging
IMAGE_TAG=staging-latest docker compose -p deda-staging --env-file env/.env.staging \
  -f docker/docker-compose.yml -f docker/docker-compose.staging.yml up -d
# prod 同理：-p deda-prod、--env-file env/.env.prod、-f docker/docker-compose.prod.yml、IMAGE_TAG=prod-latest
```

worker 容器只在传过对应 tag 的 worker 镜像时才能拉起；手动操作要显式加 `--profile video`：

```bash
docker compose -p deda-staging --env-file env/.env.staging \
  -f docker/docker-compose.yml -f docker/docker-compose.staging.yml --profile video up -d
```

staging 的 worker 容器名是 `deda-server-video-worker-staging`（`docker-compose.staging.yml`
覆盖）；base compose 的 `deda-server-video-worker` 留给 prod/历史容器，避免 Docker 的
container name 冲突。

若只想让流水线重建 worker 而不改业务代码（例如首次预置镜像、或改了 `/opt/deda/env/.env.staging`
里的 `VIDEO_*` 需要重载），手动跑一次 Deploy Staging：`workflow_dispatch` 的 `force_worker`
默认即 `true`。

### 回滚

镜像 tag 即版本。回滚到某个历史提交：

```bash
cd /opt/deda
IMAGE_TAG=prod-<旧sha> docker compose -p deda-prod --env-file env/.env.prod \
  -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d app
```

注意：若新旧版本之间含 Prisma migration，回滚代码不回滚数据库结构（Prisma migrate 只前进）；回滚前确认 schema 兼容。

### 查看日志

```bash
docker logs -f deda-server-staging
docker logs -f deda-server-prod
```

## 5. 数据库备份（每日 → OSS）

前提：安装 [ossutil](https://help.aliyun.com/zh/oss/developer-reference/install-ossutil) 并配置好凭证，建好备份 Bucket（如 `oss://deda-backup`）。

```bash
# /opt/deda/backup.sh
#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
docker exec deda-postgres-prod pg_dump -U deda deda | gzip > "/opt/deda/backups/deda-prod-${DATE}.sql.gz"
ossutil cp "/opt/deda/backups/deda-prod-${DATE}.sql.gz" "oss://deda-backup/postgres/"
find /opt/deda/backups -name '*.sql.gz' -mtime +7 -delete
```

```bash
chmod +x /opt/deda/backup.sh
# crontab -e：每天凌晨 3:47（避开整点；03:17 那一格是 certbot 续期，别撞）
47 3 * * * /opt/deda/backup.sh >> /opt/deda/backups/backup.log 2>&1
```

恢复演练（建议每月一次）：`gunzip -c <备份> | docker exec -i deda-postgres-prod psql -U deda deda`。

服务器实态（2026-11-15 核对）：

- cron 三条：`03:17 周一` certbot 续期、`03:47 每天` backup.sh、`04:07 周日` prune-images.sh。
- **`ossutil` 同步行仍注释着**（脚本内 `TODO(oss)`）。备份只落在 `/opt/deda/backups/`，与数据库
  同一块盘——磁盘故障或误删时备份一起没，**目前不构成异地备份**。装好 ossutil、配好凭证后
  取消该行注释才算闭环。
- 脚本对「prod postgres 容器不存在」静默跳过：prod 上线前每日 cron 不报错，但**也不产生任何
  dump**（`/opt/deda/backups/` 里只有 backup.log）。prod 首次部署后必须回来确认次日有 `.sql.gz`。
- 本地保留 7 天（`find -mtime +7 -delete`）。

生产部署加固（2026-11-13 起生效）：

- **部署前备份**：`deploy-prod.yml` 在部署前自动执行 `backup.sh`（未安装则告警跳过）。
- **自动回滚**：部署成功才写入 `/opt/deda/env/.last-good-tag`；健康检查失败时 workflow 自动把 `IMAGE_TAG` 指回上一个好版本重新 `up -d`（见 §4 回滚）。首次部署无历史好版本时报错人工介入。
- **镜像保留策略**：ECS `/opt/deda/prune-images.sh`（cron 每周日 04:07），保留最近 5 个 `prod-*` 与 3 个 `staging-*` 镜像，其余删除——2026-11-13 实测僵尸镜像占 25G/33G 磁盘。worker 镜像同样按 `staging-<sha>` 累积，**需确认该脚本的镜像过滤包含 `deda-server-video-worker`**（脚本不在仓库内），否则只增不减。
- **磁盘告警**：云监控磁盘 >75% 告警。
- **生产 MQTT**：prod compose 含 mosquitto（容器 `deda-mqtt-prod`，宿主机端口 `1884`，配置在 `/opt/deda/mosquitto-prod/`），设备接入 `mqtt://valleyletters.com:1884`。1883 归 staging，互不干扰。

## 6. 备案后切换清单（已于 2026-11-12 全部完成）

域名 ICP 备案已完成（沪ICP备2026060466号-1，valleyletters.com），执行记录：

1. ~~DNS~~：已把 `valleyletters.com`、`www`、`staging` A 记录指向 ECS 公网 IP（2026-11-12）。
2. ~~nginx.prod.conf~~：已替换为真实域名，随本 commit 同步到服务器。
3. ~~证书~~：Let's Encrypt 已签发（standalone 模式），证书在 ECS `/etc/letsencrypt/live/`，自动续期 `/opt/deda/certbot/renew.sh`（每周一 03:17 cron）。
4. ~~安全组~~：`80`、`443` 已放行（系统规则）。
5. 微信小程序后台：request 合法域名加入 `https://valleyletters.com`；staging 联调用 `https://staging.valleyletters.com`。
6. 验证：`curl -I https://valleyletters.com/api/docs`、`curl -I https://staging.valleyletters.com/api/docs`。
7. 可选：安全组收回 `3001`（staging 此后走域名）。

## 6.1 deda-dashboard 静态托管

dashboard SPA（deda-dashboard 仓库）由两条通道承载，共用同一份产物目录：

| 通道 | 适用期 | 入口 |
| --- | --- | --- |
| Nest 内嵌托管（ServeStaticModule，`serveRoot=/dashboard`） | 备案期间 staging 直连 | `http://<ECS_IP>:3001/dashboard/` |
| nginx `location /dashboard/`（alias + SPA 回退） | 备案后正式形态，Nest 保留为兜底 | `https://valleyletters.com/dashboard/`、`https://staging.valleyletters.com/dashboard/` |

产物目录约定（**由 deda-dashboard 仓库流水线负责 build 并投递**，本仓库 CI 只 `mkdir -p`）：

- staging：`/opt/deda/dashboard/staging/`（`DASHBOARD_DIST_PATH` 已在 compose 固定）
- prod：`/opt/deda/dashboard/prod/`

app 容器挂载的是**父目录** `/opt/deda/dashboard`（只读），而非子目录本身：流水线投递时
删建 staging/prod 子目录对容器透明，无需 recreate 容器。切勿把 compose 改回挂载子目录
——bind mount 绑定的是目录 inode，子目录被删后容器会永久看到空目录（/dashboard 404，
`ENOENT ... stat index.html`），只能 recreate 容器才能恢复。

本地开发要预览托管效果：在 deda-dashboard 里 `npm run build`，然后
`DASHBOARD_DIST_PATH=<deda-dashboard>/dist npm run start:dev`，访问 `http://localhost:<APP_PORT>/dashboard/`。
`DASHBOARD_DIST_PATH` 目录不存在时静态托管自动跳过，不影响 API 启动。

注意：静态壳本身无鉴权（内部工具约定），数据接口仍走 `/analytics/*` 的 JWT 鉴权。

## 6.2 prod 首次上线 runbook（截至 2026-11-15 尚未执行）

prod 侧已就位：nginx（容器 `deda-nginx-prod`，compose 项目名 `deda-prod`）、双域名证书、DNS、
备案、mosquitto 配置（`/opt/deda/mosquitto-prod/`）、`/opt/deda/env/.env.prod`。
**app / postgres / redis / mosquitto 都还没起**——所以现在 `https://valleyletters.com/api/docs`
返回 502 是预期状态，不是故障。

### 0. 前置检查（ECS 上）

```bash
# 项目名必须是 deda-prod。漏了 -p 会落到默认项目名 docker，容器 label 变成
# com.docker.compose.project=docker，此后 compose 认不出这些容器，还会与 staging
# 抢容器名和卷名（2026-11-14 踩过：nginx 被错投到 prod 项目上，只能删了重建）。
docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'

# 错项目名留下的孤儿卷，确认 SIZE=0B 且 LINKS=0 后再删
docker volume ls | grep -E 'docker_(postgres|redis)-data'

# 安全组（阿里云控制台，不是本机）：1884 必须放行，prod MQTT 靠它；1883 归 staging
```

### 1. 触发部署

合并 `staging → main` 的发布 PR。ci.yml 全绿后 `deploy-prod` 调用 deploy-prod.yml，
**停在 `production` environment 等人工批准**。批准后流水线自动完成：build → SSH 直传镜像 →
同步 compose → 部署前 `backup.sh` → `up -d` → 回环健康检查（`127.0.0.1:3000/api/docs`）→
写 `.last-good-tag`；健康检查不过则自动回滚。

`up -d` 会拉起 prod 全套（app / postgres / redis / mosquitto）。nginx 若因配置差异被重建，
**staging 域名会跟着闪断 1–2 秒**——同一个 nginx 容器服务两个域名。

### 2. 首次部署特有的三件事

- **库是从零建的**：migration 由容器 CMD 执行（`prisma migrate deploy` 成功后才 `node dist/src/main`），
  空库上会顺序跑完全部 **31** 个 migration。其中 4 个含 `DROP COLUMN`（最后一个是
  `20261113141812_remove_conversation_mode_key`）——空库上无害，但**不要**为了省事把 staging 的
  dump 灌进 prod：那会让破坏性迁移作用在真实数据上，还会把 staging 的设备、对话、孩子档案
  带进生产。prod 数据从零开始。
- **没有可回滚的历史版本**：`.last-good-tag` 首部署前不存在，健康检查失败时自动回滚无处可回，
  流水线直接 exit 1。这是设计（宁可停下，也别把服务器留在未知状态），需人工上机排查。
- **内容只读**：prod compose 刻意不设 `CONTENT_ADMIN_PROFILE`，内容管理台在 prod 一律只读
  （fail-safe，缺省与拼错都按 readonly 处理）。内容要在 staging 创作验证后，用管理台的导入功能搬过去。

### 3. 上线后验证

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://valleyletters.com/api/docs    # 期望 200（此前 502）
curl -sS -o /dev/null -w '%{http_code}\n' https://valleyletters.com/dashboard/  # 期望 200
docker logs --tail 50 deda-server-prod
docker exec deda-postgres-prod psql -U deda deda -c 'select count(*) from "_prisma_migrations"'  # 期望 31
ls -la /opt/deda/backups/    # 次日确认 backup.sh 真的产出了 .sql.gz（见 §5 实态）
```

`/opt/deda/dashboard/prod/` 里目前是 2026-11-07 的旧构建：`/dashboard/` 能打开但内容是旧的，
需要 deda-dashboard 仓库补一次 prod 投递（产物由那边的流水线负责，本仓库只 `mkdir -p`）。

### 4. 同机双栈的内存预算

ECS 2 vCPU / 3623 MiB，staging 与 prod 同机。护栏口径由
`src/common/workflows/compose-env-gate.spec.ts` 钉住，改坏即 CI 红：

| 容器 | memory limit | NODE_OPTIONS |
| --- | --- | --- |
| `deda-server-prod` | 1536M | `--max-old-space-size=1024` |
| `deda-postgres-prod` | 512M | — |
| `deda-redis-prod` | 128M | — |
| `deda-server-staging` | 1G | `--max-old-space-size=768` |

- limit 是**上限不是预留**：实测五个容器稳态合计约 160 MiB。设 limit 是防止任一进程失控时
  把邻居挤进 swap。prod 整栈 limit 之和 2.5 GiB。
- `--max-old-space-size` 必须明显小于容器 limit（脚本要求至少留 128M）。Node 按**宿主机**总内存
  推算老生代上限、不看 cgroup limit，不限定就会在 GC 触发前把容器撑爆被 OOM kill
  （退出码 137，日志里看不到 JS 堆溢出记录，极易误判成「容器莫名重启」）。
- `deda-redis-prod` 未配 `maxmemory`：触顶是被 kill 而不是淘汰键。当前只放熔断标记、设备状态
  TTL 等小键，若日后当缓存用，128M 要同步上调。

## 7. 故障排查

| 症状 | 排查 |
| --- | --- |
| Actions 部署失败于 Build | 看 workflow 日志；本地复现 `docker build -f docker/Dockerfile .` |
| 容器起来又退出 | `docker logs deda-server-staging`，多为 migrate deploy 失败（DB 连接 / migration 冲突） |
| 健康检查失败 | ECS 上 `curl -v 127.0.0.1:3001/api/docs`；查安全组 3001 是否放行 |
| staging/prod 串数据 | 不可能共用库；确认 `-p` 项目名与 `--env-file` 没写错 |
| 磁盘满 | `docker system df`；`docker image prune -a` 清理旧镜像 |
| `/dashboard` 突然 404（ENOENT stat index.html） | 容器内 `ls /opt/deda/dashboard/staging` 为空而宿主机有文件 → 挂载失效（多因 compose 挂了子目录且流水线删建目录）；确认 compose 挂的是父目录后 `up -d --force-recreate app` |
| env 文件里改了值，容器里却不生效 | `docker/docker-compose.yml` 的 `environment` 是**白名单**，没列进去的键不会进容器且不报错。`docker exec deda-server-prod env \| grep <KEY>` 验证；缺了就补进白名单（口径见 `src/common/workflows/compose-env-gate.spec.ts`） |
| 容器反复重启、退出码 137、日志里没有 JS 堆溢出 | OOM kill。`docker inspect <容器> -f '{{.State.OOMKilled}} {{.State.ExitCode}}'` 确认；再看 `NODE_OPTIONS` 的 `--max-old-space-size` 是否小于该容器的 memory limit（见 §6.2 第 4 节） |

## 8. 展示型 Elly 素材（app-assets）

运营在 dashboard 上传自有图片，小程序按 key 显示、失败回退包内图；没有用户上传/头像/签名 URL。manifest 公开读（`GET /app-assets/manifest`，无鉴权）。

### 展示位注册表

注册表存 DB 表 `app_asset_slots`（key 主键，key = `page/suffix`）。迁移只 seed 内置探针 `diagnostics/remote-probe`，业务展示位由 dashboard「图片素材 → 新建展示位」创建。

- 部署顺序：先 `prisma migrate deploy`（含本表与 seed），再发新代码；新代码依赖该表存在。
- staging / prod 各自创建业务展示位，不做跨环境搬运。
- 停用展示位前必须先下架其线上素材（服务端 409）；不提供物理删除，建错的 key 只能永久停用。
- 新建展示位后，小程序侧必须在 `miniprogram/constants/app-asset-keys.ts` 登记 key 并在目标页面接入，发版后才会展示。

### 环境变量

| 键 | staging 示例 | prod 示例 | 说明 |
| --- | --- | --- | --- |
| `APP_ASSET_STORAGE_DRIVER` | `local` | `local` | 存储驱动，本期只实现 local |
| `APP_ASSET_LOCAL_DIR` | `/opt/deda/app-assets/staging` | `/opt/deda/app-assets/prod` | 本地文件根目录（启动前自动 mkdir） |
| `APP_ASSET_PUBLIC_BASE_URL` | `https://staging.valleyletters.com/app-assets/files` | `https://valleyletters.com/app-assets/files` | 公开访问 base URL |
| `APP_ASSET_HOSTS` | `staging.valleyletters.com` | `valleyletters.com` | URL host 白名单（逗号分隔）；留空回落到 PUBLIC_BASE_URL 的 host |
| `APP_ASSET_MAX_BYTES` | `2097152` | `2097152` | 单文件上限（默认 2 MiB） |
| `APP_ASSET_MAX_DIMENSION` | `8000` | `8000` | 宽高上限（默认 8000） |

### 文件与 URL

- 文件路径：`<APP_ASSET_LOCAL_DIR>/<key 分段>/v<version>-<sha256 前16位>.<ext>`；key 每段只允许 `[a-z0-9-]+`。
- 公开 URL：`${APP_ASSET_PUBLIC_BASE_URL}/${相对路径}`；上传/发布时校验 URL host 在有效白名单（生产禁止 http/IP/端口，非生产允许 localhost）。
- 静态托管：`AppAssetsFilesController` 把 `APP_ASSET_LOCAL_DIR` 下的文件暴露在 `/app-assets/files/*`（长缓存，内容哈希文件名）；nginx 已把 `/` 反代到 app。
- nginx 需允许 2MB 上传：仓库内 `nginx/nginx.prod.conf` 已设 `client_max_body_size 4m`，默认 1m 会 413。

### 微信后台

小程序用 `downloadFile` 拉取素材，需要把同一域名加入微信后台的 **downloadFile 合法域名**（request 合法域名与 downloadFile 合法域名是两套白名单）：
- staging：`https://staging.valleyletters.com`
- prod：`https://valleyletters.com`

### 部署注意

- 多实例子目录共享卷由部署解决（`/opt/deda/app-assets` 父目录挂载、子目录隔离），不实现对象存储驱动。
- 新增环境变量必须同步进 `docker/docker-compose.yml` 的 `environment` 白名单（口径见 `src/common/workflows/compose-env-gate.spec.ts`）。
