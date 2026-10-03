---
name: dsh-collab
description: "与 DeepSeek Harness 编码协作。当用户要写代码、建项目、改代码时使用：把编码任务交给本机 DeepSeek Harness 执行（DeepSeek 写代码，你负责验收）。两种派活方式——默认在 --cwd 指定的工作目录新建编码子代理；也可以把任务投递进**用户正在用的那一条已有会话**（保留它自己的上下文，不新建会话/工作区）。DeepSeek 完成后可自动 git 提交，并可用独立评审子代理审查 diff（评审员会实际跑通构建/测试）。不通过则发修正指令迭代，直到通过再向用户汇报。"
---

# DeepSeek Harness 编码协作

## 角色

- 你 = 项目经理 + 验收员。DeepSeek 编码子代理 = 程序员。
- 子代理保留跨任务记忆；独立评审子代理与编码员分离，不信任口头报告，只认真实文件与真实运行结果。

## 两种派活目标（先想清楚要哪一种）

| 目标 | 什么时候用 | 效果 |
|---|---|---|
| **worker**（默认） | 全新任务、独立项目目录 | 在 `--cwd` 里新建一个持久编码子代理 |
| **session** | 用户已经在某条会话里做着这件事（例如"按文档启动OKX策略实验计划"），你只是替他继续推进 | 指令**投递进那条会话**，用它自己的上下文继续，**不新建会话/工作区** |

> 默认是 worker。如果你把任务派进了新建的会话，而用户期望的其实是"接着我原来那条对话做"，那是**派错了目标**——先查会话再派。

## 工具脚本（固定位置）

- 派活：`dsh-task`（npm 全局安装后进 PATH）
- 评审：`dsh-review`
- MCP 服务器：`dsh-mcp`

若 PATH 里没有，用包内绝对路径：`node "<包目录>/codex-plugin/plugins/dsh/skills/dsh-collab/scripts/task.mjs"`。

## 找到已有会话（只读，不创建任何东西）

```bash
dsh-task --sessions "<标题或内容关键词>"
```

输出候选（`sessionId` + 片段）。**必须唯一命中**才能直接用；多条会返回 `candidates` 让你改用 `--session <id>`。退出码 `4` = 没命中或不唯一。

## 下发任务

```bash
# 1) 新建子代理（原有行为）
dsh-task --in "<完整中文指令>" --cwd "<工作目录>" [--lane <通道>] [--model fast|pro] [--commit] [--timeout 秒]

# 2) 投递进已有会话
dsh-task --in "<完整中文指令>" --session "<sessionId>" [--steer] [--timeout 秒]
dsh-task --in "<完整中文指令>" --find "<标题关键词>"     # 唯一命中才派发，否则退出码 4
```

- `--cwd`：**默认传 Codex 当前打开的项目目录**（绝对路径，正斜杠）；不存在时自动创建并注册为 harness 工作区。与 `--session`/`--find` 互斥。
- `--lane`：并行通道名（默认 main）。同一目录不同 lane 的任务**并行执行**；跨目录天然并行。
- `--model`：`fast`（deepseek-v4-flash，快而省）或 `pro`（deepseek-v4-pro，质量优先）；默认继承当前模型。session 目标不使用此参数（会话自己有模型）。
- `--commit`：任务完成后在 `--cwd` 自动 `git add -A` 并提交；非 git 仓库自动跳过。session 目标禁止使用（会话自带工作目录，本工具不替它提交）。
- `--steer`：仅 session 目标。默认 `queue`（排队，等它忙完再跑）；`--steer` 会插入当前回合、改变它正在做的事——**只在用户明确要求打断时用**。
- 指令必须包含：目标与产出物、验收标准、约束。`--wait` 为默认行为（结果直接回本对话），长任务加 `--timeout 1800`。

退出码：`0` 成功 / `1` 失败 / `2` 用法 / `3` 超时 / `4` 会话未命中或不唯一 / `5` session 目标取消被拒。

## 读取汇报与验收

1. 脚本最后输出 `=== DeepSeek 汇报 ===`（做了什么、改动文件、如何验证、待决策问题）。
2. worker 目标：读 `--cwd` 中它声称改动的文件核对。session 目标：让用户到那条会话里看，或你再派一条只读指令让它回读。
3. 通过 → 向用户汇报；不通过 → 发修正指令（子代理/会话记得上下文），迭代到通过。

## 双向评审（Codex 验收 DeepSeek 的变更）

```bash
dsh-review --cwd "<工作目录>" [--diff git|git-staged|@文件|"diff 文本"] [--focus "<审查重点>"]
```

- `--diff` 默认取 `git diff`（未提交变更）；`git-staged` 取暂存区；也可直接给 diff 文本或文件（`@路径`）。
- 评审员会：读 `--cwd` 真实文件核对 diff → 静态审查（正确性/健壮性/安全/测试缺口）→ **实际运行构建与测试验证可跑通** → 输出结构化报告。
- **评审不支持 session 目标**：评审员必须与编码会话隔离，否则"独立评审"就不成立。

## 任务管理

```bash
dsh-task --list                        # 最近任务列表
dsh-task --status <taskId>             # 查询单个任务（含 target 回显）
dsh-task --cancel <taskId>             # 取消 worker 任务
dsh-task --cancel <taskId> --force     # 取消 session 目标任务（会打断用户自己的回合，默认被拒）
```

## 故障排查

- 连接失败：DeepSeek Harness 未运行（网关应监听本机端口，默认 3080；挂在 web/desktop profile 时也可能就是 GUI 的端口）。
- 派 session 任务返回 `session-writer-held` / `session-busy`：那条会话被别的写入方或另一个 bridge 任务占用；稍后重试，或改用 worker 目标。
- 返回 `session-busy: owned by subagent routing`：那是子代理会话，**不能作为投递目标**；只能接普通会话。
- 返回 `session-not-activatable` / `session-archived`：该会话当前接不了（冷会话未能激活，或已归档）；请用户先在客户端打开它，或解除归档。
- 某些部署禁用了搜索（会话索引 `openAt: never`）：`--sessions` 会自动退回 `list` + 标题投影匹配，响应里的 `matchedBy` 会写 `list`。
- 读不到 `--cwd` 目录：提示用户在 Codex 设置中把该目录加入可访问/可写目录。
