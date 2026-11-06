# 零基础部署手把手教程（deda-server → 阿里云 ECS）

> 适合对象：第一次做部署和后端运维的开发者。
> 读完做完大约需要 **1.5～2 小时**。每一步都有「验证方法」，通过后再走下一步。
>
> 本文是操作手册；架构原理和命令速查见同目录 `deployment.md`。

---

## 0. 先搞懂这条链路（3 分钟）

```
你的电脑                    GitHub                        阿里云
┌──────────┐   git push   ┌──────────────┐  构建镜像   ┌─────────────┐
│ 写代码    │ ───────────▶ │ Actions 机器人 │ ─────────▶ │ ACR 镜像仓库 │
└──────────┘              └──────┬───────┘            └──────▲──────┘
                                 │ SSH 远程执行命令            │ 拉取镜像
                                 ▼                           │
                          ┌─────────────────────────────────┴───┐
                          │ ECS 服务器（跑 Docker 容器）          │
                          │  deda-server-staging → 端口 3001      │
                          │  deda-server-prod    → 端口 3000      │
                          └──────────────────────────────────────┘
```

你只需要记住 4 个名词：

| 名词 | 是什么 | 类比 |
| --- | --- | --- |
| **ECS** | 你买的那台阿里云服务器 | 一台永远开着的远程电脑 |
| **Docker / 镜像 / 容器** | 把代码+依赖打包成一个「盒子」运行 | 镜像是安装包，容器是运行中的程序 |
| **ACR** | 阿里云的镜像仓库 | 镜像的「网盘」 |
| **GitHub Actions** | GitHub 提供的自动化机器人 | 你一 push 代码，它就自动干活 |

** secrets（密钥）分两边放**：

- 服务器上：`/opt/deda/env/.env.staging` 和 `.env.prod`（数据库密码、微信密钥、LLM key 等，只存在服务器上）
- GitHub 上：仓库 Secrets（Actions 机器人登录 ACR 和 SSH 登录 ECS 用的凭证）

---

## 1. 准备工作（10 分钟）

确认你手上有这些东西：

- [ ] 阿里云账号，已买 ECS（4G 内存），**记下 ECS 的公网 IP**（控制台首页能看到）
- [ ] ECS 的操作系统是 **Ubuntu 22.04** 或 Alibaba Cloud Linux 3（如果还没装系统或想重装，控制台 → 实例 → 更换操作系统，选 Ubuntu 22.04 64位）
- [ ] 你的 GitHub 账号对 `aldy97/deda-server` 有管理员权限（你是 owner，有）
- [ ] 本地 `.env` 文件里的真实密钥（DeepSeek API Key、微信小程序 AppID/Secret 等，等下要抄到服务器上）

> ⚠️ 重装系统会清空 ECS 数据。刚买的新机器无所谓。

---

## 2. 阿里云控制台：放行端口（5 分钟）

ECS 有一堵「防火墙」叫**安全组**，默认只开了 22 端口（SSH）。需要加一条 3001（staging 临时访问用）。

1. 登录[阿里云控制台](https://ecs.console.aliyun.com) → 云服务器 ECS → 实例 → 点你的实例
2. 左侧「安全组」→ 点击安全组 ID → 「入方向」→「手动添加」
3. 添加这两条规则：

| 端口范围 | 授权对象（源） | 用途 |
| --- | --- | --- |
| `22/22` | `0.0.0.0/0`（建议改成你的家庭 IP，更安全） | SSH 登录 |
| `3001/3001` | `0.0.0.0/0` | staging 临时访问（备案后收回） |

**不要**开放 3000 / 5432 / 6379（生产和数据库端口，外部不需要直接访问）。

✅ **验证**：列表里能看到这两条规则即可。

---

## 3. 第一次 SSH 登录服务器（5 分钟）

在你**自己电脑**的终端（Mac 的「终端」App）执行：

```bash
ssh root@你的ECS公网IP
```

- 如果买的时候设了密码，输入密码即可
- 如果买的是密钥登录，用 `ssh -i 你的密钥.pem root@你的ECS公网IP`
- 第一次连接会问 `Are you sure you want to continue connecting?`，输入 `yes`

看到命令行提示符变成 `root@iZxxxxxZ:~#` 之类的，就成功了。

> 后文约定：**`[ECS]`** 开头表示在服务器上执行，**`[本地]`** 表示在你 Mac 上执行。

---

## 4. 在 ECS 上安装 Docker（10 分钟）

`[ECS]` 依次执行：

```bash
# 1. 安装 Docker（官方一键脚本，Ubuntu 和 Alibaba Cloud Linux 都支持）
curl -fsSL https://get.docker.com | sh

# 2. 启动 Docker 并设置开机自启
systemctl enable --now docker

# 3. 验证
docker version
docker compose version
```

✅ **验证**：`docker version` 显示 Client 和 Server 两部分版本号；`docker compose version` 显示 `v2.x.x`。

如果 `docker compose version` 报错找不到命令（老系统可能没装插件）：

```bash
# Ubuntu
apt-get install -y docker-compose-plugin
# Alibaba Cloud Linux
dnf install -y docker-compose-plugin
```

**创建部署目录并退出 root**（后续用普通用户更安全，也可全程用 root，教程按 root 写）：

```bash
mkdir -p /opt/deda/env /opt/deda/backups
```

---

## 5. 开通 ACR 镜像仓库（10 分钟）

1. 打开[容器镜像服务控制台](https://cr.console.aliyun.com)，**左上角地域选「华东2（上海）」**（与 ECS 同地域，推拉镜像快）
2. 选择**个人实例**（免费）→ 创建实例
3. 首次使用会要求设置 **Registry 登录密码**——设置后**记下来**，这就是后面的 `ACR_PASSWORD`
4. 进入实例 → 「命名空间」→ 创建命名空间，比如叫 `deda`（这就是 `ACR_NAMESPACE`）
5. 「访问凭证」页面能看到：
   - 登录地址 `registry.cn-shanghai.aliyuncs.com`（这就是 `ACR_REGISTRY`）
   - 登录用户名（这就是 `ACR_USERNAME`，通常是你的阿里云账号名）

> 地域建议和 ECS 选同一个（比如都在杭州），推送/拉取速度快。镜像仓库不需要手动创建，第一次推送会自动生成。

✅ **验证**：`[ECS]` 上执行（把地址换成你页面上的）：

```bash
docker login --username=你的用户名 registry.cn-shanghai.aliyuncs.com
# 输入刚才设置的 Registry 密码，看到 Login Succeeded 即可
```

---

## 6. 生成 GitHub Actions 专用的 SSH 密钥（5 分钟）

Actions 机器人需要一个「钥匙」来登录你的 ECS。**不要**复用你自己的钥匙，单独生成一对：

`[本地]` Mac 终端执行：

```bash
# 生成密钥对（一路回车，不要设密码）
ssh-keygen -t ed25519 -f ~/.ssh/deda-github-actions -C "github-actions-deploy"

# 查看公钥（等下放到服务器上）
cat ~/.ssh/deda-github-actions.pub

# 查看私钥（等下填到 GitHub Secrets）
cat ~/.ssh/deda-github-actions
```

`[ECS]` 把**公钥**（`.pub` 那一行）追加到服务器：

```bash
echo "把公钥完整粘贴到这里" >> ~/.ssh/authorized_keys
```

✅ **验证**：`[本地]` 执行 `ssh -i ~/.ssh/deda-github-actions root@你的ECS公网IP`，能免密登录就成功，然后 `exit` 退出。

---

## 7. 在 ECS 上创建环境变量文件（15 分钟）

这是最「有料」的一步——把密钥填进服务器。创建两个文件，内容模板如下。

`[ECS]` 执行 `vi /opt/deda/env/.env.staging`（不熟 vi 的话：按 `i` 进入编辑，粘贴内容，按 `Esc`，输入 `:wq` 回车）：

```bash
# ===== staging 环境 =====
NODE_ENV=staging
DB_PASSWORD=换一个强密码A_不要和prod一样
JWT_SECRET=换一个长随机字符串A_至少32位

# 微信小程序（抄你本地 .env 的值）
WECHAT_APPID=你的AppID
WECHAT_SECRET=你的AppSecret

# 机芯厂（没有就先占位）
MANUFACTURER_BASE_URL=https://api.manufacturer.example.com
MQTT_URL=mqtt://你的MQTT地址:1883
# staging 用独立 topic 前缀，避免和生产串消息
MQTT_STATUS_TOPIC=staging/zhianxin/event/report

# LLM（抄你本地 .env 的值）
OPENAI_API_KEY=你的DeepSeek-Key
SMALL_LLM_API_KEY=你的百炼-Key
```

再建 `/opt/deda/env/.env.prod`：**同样的结构**，但注意：

- `NODE_ENV=production`
- `DB_PASSWORD`、`JWT_SECRET` **必须换成与 staging 不同的值**
- `MQTT_STATUS_TOPIC` 保持默认 `zhianxin/event/report`
- 微信小程序、LLM 密钥如果正式/测试用同一套，可以先一样

最后锁权限（只有 root 能读）：

```bash
chmod 600 /opt/deda/env/.env.staging /opt/deda/env/.env.prod
```

> 💡 生成强随机密码的便捷方法：`openssl rand -base64 32`

✅ **验证**：`cat /opt/deda/env/.env.staging | wc -l` 有内容，且 `ls -l` 显示权限是 `-rw-------`。

---

## 8. 配置 GitHub Secrets（10 分钟）

这些密钥告诉 Actions 机器人「怎么登录 ACR」和「怎么登录 ECS」。

1. 浏览器打开 `https://github.com/aldy97/deda-server/settings/secrets/actions`
2. 点 **New repository secret**，逐个添加下面 7 个：

| Name | 值从哪来 |
| --- | --- |
| `ACR_REGISTRY` | 第 5 步 ACR 访问凭证页的地址，如 `registry.cn-shanghai.aliyuncs.com` |
| `ACR_NAMESPACE` | 第 5 步创建的命名空间，如 `deda` |
| `ACR_USERNAME` | 第 5 步的用户名 |
| `ACR_PASSWORD` | 第 5 步设置的 Registry 密码 |
| `ECS_HOST` | ECS 公网 IP |
| `ECS_USER` | `root`（如果全程用 root） |
| `ECS_SSH_KEY` | 第 6 步**私钥**的全部内容（`-----BEGIN` 到 `END` 整段，多行直接粘贴） |

✅ **验证**：Secrets 列表里能看到 7 个条目（值本身永远不可见，这是正常的）。

---

## 9. 第一次部署：merge 到 staging（15 分钟）

现在链路全部就位，让流水线跑起来。

### 9.1 推送部署分支并开 PR

`[本地]` 在仓库目录执行：

```bash
# 确认在部署分支上（feat/deploy-pipeline，代码已 commit）
git push -u origin feat/deploy-pipeline
```

然后打开 GitHub 仓库页面 → 会出现「Compare & pull request」提示 → 点它：

- **base 分支确认是 `staging`**（因为默认分支已改成 staging，通常自动就是）
- 标题随意，点 Create pull request

### 9.2 等 CI 变绿，然后合并

- PR 页面下方会自动跑 `ci` 检查（lint + 编译 + 单测 + e2e，约几分钟）
- 绿色 ✅ 后点 **Merge pull request** → Confirm
- 如果红了，点 Details 看日志，把报错发给 Kimi 分析

### 9.3 观察自动部署

合并后，仓库 **Actions** 标签页会出现 `Deploy Staging` 运行记录，点进去看它干活：

1. Build and push image（构建镜像推 ACR，第一次较慢，5~10 分钟）
2. Sync compose files to ECS
3. Deploy on ECS（服务器拉镜像、起容器）
4. Health check（访问 `http://你的IP:3001/api/docs`）

全绿 = 部署成功。

✅ **最终验证**：浏览器打开 `http://你的ECS公网IP:3001/api/docs`，能看到 Swagger 接口文档页面。🎉

**如果 Deploy Staging 红了**，按顺序排查：

| 报错位置 | 大概率原因 |
| --- | --- |
| Login to ACR | `ACR_USERNAME`/`ACR_PASSWORD` 填错 |
| Setup SSH / Sync | `ECS_SSH_KEY` 没粘全，或第 6 步公钥没加到服务器 |
| Deploy on ECS | 服务器上 `.env.staging` 缺变量；服务器上手动跑 `docker compose ... config` 看报错 |
| Health check | ECS 安全组没放行 3001；或容器挂了，`[ECS]` 上 `docker logs deda-server-staging` 看日志 |

---

## 10. 发布到生产：staging → main（10 分钟）

staging 验证没问题后：

1. GitHub 仓库页面 → Pull requests → New pull request
2. base: `main` ← compare: `staging`（这次要**手动把 base 改成 main**，因为默认是 staging）
3. 创建 PR → 等 CI 绿 → Merge
4. Actions 里 `Deploy Production` 自动运行

✅ **验证**：`[ECS]` 上执行：

```bash
curl -s http://127.0.0.1:3000/api/docs | head -c 100
docker ps   # 应该看到 deda-server-prod、deda-postgres-prod、deda-redis-prod、deda-server-staging 等 6+ 个容器
```

> 生产环境备案完成前只监听服务器内部（127.0.0.1），公网访问不到，这是**故意设计**的。备案完成后按 `deployment.md` 第 6 节切换到域名 + HTTPS。

---

## 11. 日常工作流（以后每天只用记住这个）

```
写代码：git checkout -b feat/新功能 staging
   ↓
提 PR 到 staging（默认就是）→ CI 绿 → 合并 → 自动部署 staging
   ↓
浏览器/小程序开发工具访问 http://IP:3001 验证
   ↓
攒一批后，开 staging→main 的 PR → 合并 → 自动部署生产
```

常用运维命令（`[ECS]`）：

```bash
# 看日志（排查问题第一步）
docker logs -f deda-server-staging
docker logs -f deda-server-prod

# 回滚到上一个版本（把 <旧sha> 换成 commit 号前 7 位）
cd /opt/deda
IMAGE_TAG=prod-<旧sha> docker compose -p deda-prod --env-file env/.env.prod \
  -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d app

# 磁盘快满时清理旧镜像
docker image prune -a
```

---

## 12. 配置数据库每日备份（10 分钟，建议做）

1. 开通阿里云 **OSS**（对象存储），创建一个 Bucket，如 `deda-backup`（私有读写）
2. `[ECS]` 安装 ossutil：

```bash
curl -o ossutil https://gosspublic.alicdn.com/ossutil/1.7.19/ossutil-v1.7.19-linux-amd64.zip
# 或按官方文档：https://help.aliyun.com/zh/oss/developer-reference/install-ossutil
# 配置凭证：ossutil config，按提示填 AccessKey 和 Endpoint
```

3. `[ECS]` 创建备份脚本 `/opt/deda/backup.sh`（完整内容见 `deployment.md` 第 5 节），然后：

```bash
chmod +x /opt/deda/backup.sh
crontab -e
# 加一行：每天凌晨 3:17 自动备份
17 3 * * * /opt/deda/backup.sh >> /opt/deda/backups/backup.log 2>&1
```

✅ **验证**：手动跑一次 `/opt/deda/backup.sh`，去 OSS 控制台看 Bucket 里有没有 `.sql.gz` 文件。

---

## 13. 名词速查 & 求助姿势

遇到问题时，把以下三样发给 Kimi 就能快速定位：

1. Actions 里失败步骤的日志（点进去复制）
2. `[ECS]` 上 `docker logs deda-server-staging --tail 50` 的输出
3. 你刚刚做的操作描述

> ⚠️ 发日志前检查有没有把密码、API Key 一起贴出来。
