#!/usr/bin/env sh
# 本地开发钩子的共用逻辑：Prisma Client 比 schema 旧（或压根没生成）时才重新生成。
#
# 为什么需要：schema 变了但 client 没跟上，编译期看不出来，运行时才炸
# （典型症状是「某张表 / relation 不存在」）。CI 与镜像各自显式生成
# （.github/workflows/ci.yml、docker/Dockerfile），所以这条只服务本地工作副本。
#
# 边界：只生成 client，不碰数据库。数据库迁移一律人工执行——切分支时自动写库
# 可能打到不该打的库上。
#
# 判定用 mtime 而不是 git diff：不读任何 git 状态，因此对 worktree add 传进来的
# 空 SHA、detached HEAD、squash 合并这些情况天然免疫。schema 内容没变时 git
# 不会重写文件，mtime 不变 → 正确跳过，切分支不刷屏。
set -u

schema="src/prisma/schema.prisma"
client="node_modules/.prisma/client/index.d.ts"

# 当前目录不是本仓（没有 schema）→ 与本仓无关，放过
[ -f "$schema" ] || exit 0

# 依赖没装（新 worktree、刚 clone）→ 想生成也生成不了，静默跳过而不是报错
[ -d node_modules/prisma ] || exit 0

# client **严格**比 schema 新才跳过。mtime 相等时（git 写 schema 与 generate 写
# client 落在同一秒）选择重新生成：代价是一次多余生成，收益是绝不留下陈旧 client。
if [ -f "$client" ] && [ "$client" -nt "$schema" ]; then
  exit 0
fi

# husky 会把 node_modules/.bin 放进 PATH，这里再兜一次，方便手动 sh 调用
PATH="node_modules/.bin:$PATH"
echo "prisma schema 有变更，重新生成 Prisma Client…"
prisma generate --schema="$schema"
