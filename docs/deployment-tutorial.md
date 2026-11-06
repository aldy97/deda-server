# 零基础部署手把手教程（deda-server → 阿里云 ECS）

> 适合对象：第一次做部署和后端运维的开发者。
> 读完做完大约需要 **1～1.5 小时**。每一步都有「验证方法」，通过后再走下一步。
>
> 本文是操作手册；架构原理和命令速查见同目录 `deployment.md`。

---

## 0. 先搞懂这条链路（3 分钟）

```
你的电脑                    GitHub                          阿里云
┌──────────┐   git push   ┌──────────────┐   SSH 直传镜像  ┌────────────────┐
│ 写代码    │ ───────────▶ │ Actions 机器人 │ ─────────────▶ │ ECS 服务器      │
└──────────┘              │ （构建镜像）   │   + 远程执行命令 │ （跑 Docker 容器）│
                          └──────────────┘                │  staging → 3001 │
                                                          │  prod    → 3000 │
                                                          └────────────────┘
```

你只需要记住 3 个名词：

| 名词 | 是什么 | 类比 |
| --- | --- | --- |
| **ECS** | 你买的那台阿里云服务器 | 一台永远开着的远程电脑 |
| **Docker / 镜像 / 容器** | 把代码+依赖打包成一个「盒子」运行 | 镜像是安装包，容器是运行中的程序 |
| **GitHub Actions** | GitHub 提供的自动化机器人 | 你一 push 代码，它就自动干活 |

> 注：本方案**不使用镜像仓库**——Actions 构建完镜像后通过 SSH 直接传给 ECS（`docker save` → `docker load`）。因为 ACR 个人版要求个人实名认证账号，企业认证账号无法开通；单服务器场景下直传更简单、 Secrets 更少。

**密钥分两边放**：

- 服务器上：`/opt/deda/env/.env.staging` 和 `.env.prod`（数据库密码、微信密钥、LLM key 等，只存在服务器上）
- GitHub 上：仓库 Secrets（Actions 机器人 SSH 登录 ECS 用的凭证，只有 3 个）

---

## 1. 准备工作（10 分钟）

确认你手上有这些东西：

- [ ] 阿里云账号，ECS 已购买（你的：华东2上海，2核4G，Ubuntu 22.04，公网 IP `8.133.236.127`）
- [ ] ECS 的登录密钥文件 `~/.ssh/_valleyletters.pem`（✅ 已确认可登录）
- [ ] 你的 GitHub 账号对 `aldy97/deda-server` 有管理员权限（你是 owner，有）
- [ ] 本地 `.env` 文件里的真实密钥（DeepSeek API Key、微信小程序 AppID/Secret 等，等下要抄到服务器上）

> 后文约定：**`[ECS]`** 开头表示在服务器上执行（SSH 会话里，提示符是 `root@...:~#`），**`[本地]`** 表示在你 Mac 上执行（提示符是 `xiong@...%`）。

**登录服务器**（`[本地]`）：

```bash
ssh -i ~/.ssh/_valleyletters.pem root@8.133.236.127
```

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

## 3. 在 ECS 上安装 Docker（10 分钟）

> ⚠️ **不要用** `get.docker.com` 官方脚本——国内服务器连不上。用下面的阿里云镜像源。

`[ECS]` 依次执行：

```bash
# 1. 添加阿里云 Docker 软件源
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list

apt-get update

apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

> 安装中途可能弹出紫色界面的「服务重启确认」（Package configuration），一路回车即可。

```bash
# 2. 配置镜像加速器（否则拉 postgres/redis 镜像会很慢）
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["https://e6bgth1z.mirror.aliyuncs.com"]
}
EOF
systemctl restart docker

# 3. 验证
docker version
docker compose version
docker info | grep -A1 "Registry Mirrors"
```

✅ **验证**：`docker version` 显示 Client 和 Server 两部分版本号；`docker compose version` 显示 `v2.x.x`；最后一条显示加速器地址。

**创建部署目录**：

```bash
mkdir -p /opt/deda/env /opt/deda/backups
```

---

## 4. 生成 GitHub Actions 专用的 SSH 密钥（5 分钟）

Actions 机器人需要一个「钥匙」来登录你的 ECS。**不要**复用你自己的 `_valleyletters.pem`，单独生成一对：

`[本地]` Mac 终端执行：

```bash
# 生成密钥对（一路回车，不要设密码）
ssh-keygen -t ed25519 -f ~/.ssh/deda-github-actions -C "github-actions-deploy"

# 查看公钥（等下放到服务器上）
cat ~/.ssh/deda-github-actions.pub

# 查看私钥（等下填到 GitHub Secrets）
cat ~/.ssh/deda-github-actions
```

`[ECS]` 把**公钥**（`.pub` 输出的那一整行）追加到服务器：

```bash
echo "把公钥完整粘贴到这里" >> ~/.ssh/authorized_keys
```

✅ **验证**：`[本地]` 执行 `ssh -i ~/.ssh/deda-github-actions root@8.133.236.127`，能免密登录就成功，然后 `exit` 退出。

---

## 5. 在 ECS 上创建环境变量文件（15 分钟）

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
# MQTT 暂无 broker：填占位地址，应用正常启动，设备状态推送链路待接入机芯厂后再改
MQTT_URL=mqtt://127.0.0.1:1883
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

## 6. 配置 GitHub Secrets（5 分钟）

这些密钥告诉 Actions 机器人「怎么登录 ECS」。只需要 **3 个**。

1. 浏览器打开 `https://github.com/aldy97/deda-server/settings/secrets/actions`
2. 点 **New repository secret**，逐个添加：

| Name | 值 |
| --- | --- |
| `ECS_HOST` | `8.133.236.127` |
| `ECS_USER` | `root` |
| `ECS_SSH_KEY` | 第 4 步**私钥**的全部内容（`-----BEGIN` 到 `END` 整段，多行直接粘贴） |

✅ **验证**：Secrets 列表里能看到 3 个条目（值本身永远不可见，这是正常的）。

---

## 7. 第一次部署：merge 到 staging（15 分钟）

现在链路全部就位，让流水线跑起来。

### 7.1 开 PR

部署分支 `feat/deploy-pipeline` 已推送到远端。打开 GitHub 仓库页面 → Pull requests → New pull request：

- base: `staging` ← compare: `feat/deploy-pipeline`
- 点 Create pull request

### 7.2 等 CI 变绿，然后合并

- PR 页面下方会自动跑 `ci` 检查（lint + 编译 + 单测 + e2e，约几分钟）
- 绿色 ✅ 后点 **Merge pull request** → Confirm
- 如果红了，点 Details 看日志，把报错发给 Kimi 分析

### 7.3 观察自动部署

合并后，仓库 **Actions** 标签页会出现 `Deploy Staging` 运行记录，点进去看它干活：

1. Build image（构建镜像，第一次较慢，5~10 分钟）
2. Transfer image to ECS（镜像经 SSH 直传服务器，1~3 分钟）
3. Sync compose files to ECS
4. Deploy on ECS（服务器起容器，自动跑数据库 migration）
5. Health check（访问 `http://8.133.236.127:3001/api/docs`）

全绿 = 部署成功。

✅ **最终验证**：浏览器打开 `http://8.133.236.127:3001/api/docs`，能看到 Swagger 接口文档页面。🎉

**如果 Deploy Staging 红了**，按顺序排查：

| 报错位置 | 大概率原因 |
| --- | --- |
| Build image | 代码编译问题；把日志发 Kimi |
| Setup SSH / Transfer / Sync | `ECS_SSH_KEY` 没粘全，或第 4 步公钥没加到服务器 |
| Deploy on ECS | 服务器上 `.env.staging` 缺变量；服务器上手动跑 `docker compose ... config` 看报错 |
| Health check | ECS 安全组没放行 3001；或容器挂了，`[ECS]` 上 `docker logs deda-server-staging` 看日志 |

---

## 8. 发布到生产：staging → main（10 分钟）

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

## 9. 日常工作流（以后每天只用记住这个）

```
写代码：git checkout -b feat/新功能 staging
   ↓
提 PR 到 staging（默认就是）→ CI 绿 → 合并 → 自动部署 staging
   ↓
浏览器/小程序开发工具访问 http://8.133.236.127:3001 验证
   ↓
攒一批后，开 staging→main 的 PR → 合并 → 自动部署生产
```

常用运维命令（`[ECS]`）：

```bash
# 看日志（排查问题第一步）
docker logs -f deda-server-staging
docker logs -f deda-server-prod

# 回滚到上一个版本（先 docker images | grep deda-server 找到旧 tag，把 <旧sha> 换成 commit 号前 7 位）
cd /opt/deda
IMAGE_TAG=prod-<旧sha> docker compose -p deda-prod --env-file env/.env.prod \
  -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d app

# 磁盘快满时清理旧镜像
docker image prune -a
```

---

## 10. 配置数据库每日备份（10 分钟，建议做）

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

## 11. 名词速查 & 求助姿势

遇到问题时，把以下三样发给 Kimi 就能快速定位：

1. Actions 里失败步骤的日志（点进去复制）
2. `[ECS]` 上 `docker logs deda-server-staging --tail 50` 的输出
3. 你刚刚做的操作描述

> ⚠️ 发日志前检查有没有把密码、API Key 一起贴出来。
