---
name: Release → main
about: staging 合入 main 的发布 PR（聚合各 feature 的人工验证项）
---

## 发布 PR（后端侧）：`staging` → `main`

> 下面六段一个都不许删（只有 `已知待办` 标了 `<!-- optional -->`，可整段省略）。
> 本行上面这个**包裹标题不参与闸口判定**，措辞随你写；六段写成 H3（本模板的样子）或提级成 H2 都认。

### 本次带入

> 每个 feature PR 一行，**并把它的人工验证项数汇总上来**——release PR 的责任是把多个 feature 的人工验证项聚合给审批人，不是只写自己的。
>
> | feature PR | 标题 | 人工验证项数 |
> | --- | --- | --- |
> | #71 | … | 3 |

### prod 实际影响面

> 路由/接口、数据库迁移（是否可回滚、是否需先备份）、env、prod 特有闸口（如内容台只读）。

### 验证

> staging 上已取到的证据：CI run 链接与计数、实机冒烟 N/N。

### 上线后人工验证清单

> 开头必须写明：**合并本 PR 不自动上线，需先在 Actions 批准 production environment**。
> 每项给可复制粘贴的命令 + 期望输出。
> 本次含迁移的，必须含一条「容器日志应报 `No pending migrations to apply`」。

### 回滚

> 触发条件 / 步骤 / 数据回滚。并说明 `deploy-prod.yml` 的 `failure()` 自动回滚覆盖到哪、不覆盖什么。

### 已知待办（不阻塞发布）

<!-- optional -->

> 没有就写「无」，或整段删掉（本段标了 optional，缺席不判红；写了标题就必须填）。
