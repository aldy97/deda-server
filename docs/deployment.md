# 部署文档（阿里云 ECS）

本文档描述 deda-server 的 CI/CD 部署架构、服务器初始化、回滚与运维操作。

## 1. 架构总览

```
GitHub push
  ├─ staging 分支 → Deploy Staging workflow ─┐
  └─ main 分支    → Deploy Production workflow ┤
                                                ▼
                              Actions 构建镜像 → 推阿里云 ACR
                                                ▼
                              SSH 到 ECS → docker compose pull && up -d
                                                ▼
        ┌──────────────────────── ECS（一台，4G 内存）────────────────────────┐
        │  project deda-staging:  app(0.0.0.0:3001) + postgres + redis        │
        │  project deda-prod:     app(127.0.0.1:3000) + postgres + redis      │
        │  nginx(80/443)：备案完成后启用，反代两个环境                          │
        └──────────────────────────────────────────────────────────────────┘
```

- **两个环境完全隔离**：独立容器、独立数据卷、独立数据库，staging 的 migration 不会污染生产库。
- **镜像即制品**：每次部署对应唯一 tag（`staging-<sha>` / `prod-<sha>`），回滚 = 换 tag 重新部署。
- **备案期间访问方式**：staging 走 `http://ECS公网IP:3001`（非标端口不受备案拦截）；生产仅监听回环，等备案完成。

## 2. 分支模型

仓库**默认分支为 `staging`**，日常开发与发布流程：

```
feature/xxx  ──PR──▶  staging  ──PR(发布)──▶  main
 (从 staging 切出)   (自动部署 staging 环境)   (自动部署生产环境)
```

| 分支 | 说明 | 触发 | 环境 |
| --- | --- | --- | --- |
| `feature/*` | 从 `staging` 切出；新 PR 默认 base 即 staging | PR → CI | — |
| `staging` | 集成分支，merge 即部署 | push/merge → Deploy Staging | `http://ECS_IP:3001`（备案后 `staging.xxxx.com`） |
| `main` | 发布分支，只接受来自 staging 的 PR | push/merge → Deploy Production | 备案后 `xxxx.com`（HTTPS） |

- 两个分支的 push/PR 都会跑 CI（lint + tsc + build + 单测 + e2e）。
- **hotfix 规则**：紧急修复可走 `hotfix/xxx → main` 的 PR，合并后必须把 main 回合（back-merge）到 staging，否则下次发布会把 hotfix 冲掉。
- 生产发布如需人工确认：GitHub 仓库 Settings → Environments → `production` → 开启 Required reviewers。
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

1. 开通容器镜像服务 ACR（个人实例免费），创建命名空间，记录 registry 地址与访问凭证。
2. ECS 安全组放行入方向：`3001`（staging，备案期间临时用）、`22`（SSH，建议限制来源 IP）。**不要**对公网放行 3000/5432/6379。
3. 为 GitHub Actions 创建专用 SSH 密钥对，公钥加入 ECS `~/.ssh/authorized_keys`。

**GitHub 仓库 Secrets**（Settings → Secrets and variables → Actions，建议配在 `staging` / `production` 两个 Environment 里）：

| Secret | 说明 |
| --- | --- |
| `ACR_REGISTRY` | 如 `registry.cn-shanghai.aliyuncs.com` |
| `ACR_NAMESPACE` | ACR 命名空间 |
| `ACR_USERNAME` / `ACR_PASSWORD` | ACR 访问凭证 |
| `ECS_HOST` | ECS 公网 IP |
| `ECS_USER` | SSH 登录用户 |
| `ECS_SSH_KEY` | SSH 私钥（ed25519 全文） |

**首次部署前**：从 main 建 staging 分支并推送（`git checkout -b staging main && git push -u origin staging`）。

## 4. 日常操作

### 手动部署 / 重拉镜像

```bash
cd /opt/deda
# staging
IMAGE_TAG=staging-latest docker compose -p deda-staging --env-file env/.env.staging \
  -f docker/docker-compose.yml -f docker/docker-compose.staging.yml pull app
IMAGE_TAG=staging-latest docker compose -p deda-staging --env-file env/.env.staging \
  -f docker/docker-compose.yml -f docker/docker-compose.staging.yml up -d
# prod 同理：-p deda-prod、--env-file env/.env.prod、-f docker/docker-compose.prod.yml、IMAGE_TAG=prod-latest
```

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
# crontab -e：每天凌晨 3:17（避开整点）执行
17 3 * * * /opt/deda/backup.sh >> /opt/deda/backups/backup.log 2>&1
```

恢复演练（建议每月一次）：`gunzip -c <备份> | docker exec -i deda-postgres-prod psql -U deda deda`。

## 6. 备案后切换清单

域名 ICP 备案完成后按顺序执行：

1. DNS：把 `xxxx.com`、`staging.xxxx.com` A 记录指向 ECS 公网 IP。
2. 编辑 `nginx/nginx.prod.conf`：把 `xxxx.com` 占位替换为真实域名（commit 后随下次部署同步到服务器，或直接在 `/opt/deda/nginx/` 改）。
3. 签发证书：`certbot certonly --standalone -d xxxx.com -d staging.xxxx.com`（先临时停掉占用 80 的容器），证书挂进 nginx（`/etc/letsencrypt` 已在 prod compose 中挂载）。
4. 安全组放行 `80`、`443`。
5. 微信小程序后台：request 合法域名加入 `https://xxxx.com`；staging 联调用 `https://staging.xxxx.com`。
6. 验证：`curl -I https://xxxx.com/api/docs`、`curl -I https://staging.xxxx.com/api/docs`。
7. 可选：安全组收回 `3001`（staging 此后走域名）。

## 7. 故障排查

| 症状 | 排查 |
| --- | --- |
| Actions 部署失败于 Build | 看 workflow 日志；本地复现 `docker build -f docker/Dockerfile .` |
| 容器起来又退出 | `docker logs deda-server-staging`，多为 migrate deploy 失败（DB 连接 / migration 冲突） |
| 健康检查失败 | ECS 上 `curl -v 127.0.0.1:3001/api/docs`；查安全组 3001 是否放行 |
| staging/prod 串数据 | 不可能共用库；确认 `-p` 项目名与 `--env-file` 没写错 |
| 磁盘满 | `docker system df`；`docker image prune -a` 清理旧镜像 |
