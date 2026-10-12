---
name: dsh-collab
description: "与 DeepSeek Harness 编码协作。当用户要写代码、建项目、改代码时使用：把编码任务交给本机 DeepSeek Harness 执行（DeepSeek 写代码，你负责验收）。两种派活方式——默认在 --cwd 指定的工作目录新建编码子代理；也可以把任务投递进**用户正在用的那一条已有会话**（保留它自己的上下文，不新建会话/工作区）。派活时带 --origin（当前 Codex 对话 id）把任务与来源对话持久绑定，之后任何回合都能按 origin+taskId 精确取回这次任务的结果。DeepSeek 完成后可自动 git 提交，并可用独立评审子代理审查 diff（评审员会实际跑通构建/测试）。不通过则发修正指令迭代，直到通过再向用户汇报。"
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
dsh-task --sessions "<标题或内容关键词>"          # 只读列出候选
dsh-task --dry-run --find "<标题关键词>"          # 只解析目标、回显命中结果，不投递
```

输出候选（`sessionId` + 片段）。**必须唯一命中**才能直接用；多条会返回 `candidates` 让你改用 `--session <id>`。

没命中时会额外给出 `candidates`（按标题相似度 + 最近更新排序）——**换词重查，或直接确认用户指的是哪一条**。

> ⛔ **绝不投递任何消息来"验证命中"**（例如发一条「占位/测试/忽略本条」）。真实事故：调用方搜不到标题后发了条占位消息试探，它解析成了用户自己的会话，于是**作为一条真实用户消息落进对话并跑成回合**，会话里的 agent 还以为那是用户发的。验证命中只有两种合法手段：上面的 `--sessions` 和 `--dry-run`。
>
> ⛔ **看到 `delivered: true` 就不要重发**。它表示 prompt 已被那条会话接受、进了它的队列；我们只是没等到它开跑（会话可能正忙着一个很长的回合）。重发会让同一份内容在用户会话里出现两次。用 `--status <taskId>` 继续观察。

## 下发任务

```bash
# 1) 新建子代理（原有行为）
dsh-task --in "<完整中文指令>" --cwd "<工作目录>" [--lane <通道>] [--model fast|pro] [--commit] [--timeout 秒] [--origin <Codex对话id>]

# 2) 投递进已有会话
dsh-task --in "<完整中文指令>" --session "<sessionId>" [--steer] [--timeout 秒] [--origin <Codex对话id>]
dsh-task --in "<完整中文指令>" --find "<标题关键词>"     # 唯一命中才派发，否则退出码 4
```

- `--origin <id>`：**来源关联**——发起这次派活的 Codex 对话 id。**每个回合派活都要显式传它**（传当前这条对话的 id）：任务会在执行前把「来源对话 → taskId → 执行目标」持久落盘，之后任何回合都能按 `origin + taskId` 精确取回这次任务的结果。未显式传时，CLI 会退回本次调用的环境变量 `CODEX_THREAD_ID`；两者都没有就按"无关联"派活（旧行为）。`--require-origin` 表示"没有来源就拒绝派活"，不会静默降级。
- `--cwd`：**默认传 Codex 当前打开的项目目录**（绝对路径，正斜杠）；不存在时自动创建并注册为 harness 工作区。与 `--session`/`--find` 互斥。
- `--lane`：并行通道名（默认 main）。同一目录不同 lane 的任务**并行执行**；跨目录天然并行。
- `--model`：`fast`（deepseek-v4-flash，快而省）或 `pro`（deepseek-v4-pro，质量优先）；默认继承当前模型。session 目标不使用此参数（会话自己有模型）。
- `--commit`：任务完成后在 `--cwd` 自动 `git add -A` 并提交；非 git 仓库自动跳过。session 目标禁止使用（会话自带工作目录，本工具不替它提交）。
- `--steer`：仅 session 目标。默认 `queue`（排队，等它忙完再跑）；`--steer` 会插入当前回合、改变它正在做的事——**只在用户明确要求打断时用**。
- 指令必须包含：目标与产出物、验收标准、约束。`--wait` 为默认行为（结果直接回本对话），长任务加 `--timeout 1800`。

退出码：`0` 成功 / `1` 失败 / `2` 用法（含缺少来源、`--origin` 缺值、网关不支持来源绑定） / `3` 超时 / `4` 会话未命中或不唯一 / `5` session 目标取消被拒 / `6` 按 taskId 查询取不到（未知任务 / 已关联但缺来源 / 来源不匹配） / `7` 派活被拒（通道忙） / `8` 网关未确认来源绑定（可能已执行，**不要重发**）。

## 跨回合精确收取（来源关联，推荐每个回合都做）

```bash
# 派活时带来源（显式 --origin，或本次调用环境里的 CODEX_THREAD_ID）
dsh-task --in "<指令>" --cwd "<目录>" --origin "<当前对话id>"

# 下一个回合：只凭来源找回这次对话派过的任务（找回丢失的 taskId）
dsh-task --my-tasks --origin "<当前对话id>"

# 按来源 + taskId 精确取结果
dsh-task --status "<taskId>" --origin "<当前对话id>"
```

- **归属靠来源，收取靠 taskId**：来源对话 id 决定"这次任务属于哪条对话"，taskId 决定"是哪一次派活"。两者都不匹配时查询**明确拒绝**（退出码 6，绝不返回别的对话的结果）。
- `taskId` 是**关联标识**，不是授权凭据，也不是线程 id；`originThreadId` 只是关联元数据。
- **来源必须在派活前核验网关真的支持**（只读能力查询，不是猜版本）：旧网关会忽略 `originThreadId` 却照常返回 accepted，从而产生"未绑定"任务——所以带来源的派活/查询在**不支持时直接拒绝、零执行**。旧的无来源调用仍然兼容。
- **显式来源必须合法**：空串 / null / 纯空白 / 非字符串一律拒绝（退出码 2 / `invalid-origin`），**不会**回落到无关联模式，也不会改用环境变量。
- **同一通道（`--cwd` + `--lane`）同时只允许一个在途任务**：第二个会被明确拒绝（`worker-bucket-busy` / `reviewer-bucket-busy`，退出码 7）——因为完成事件只能归属到"通道里最老的那个任务"。等它结束，或换一个 `--lane` 并行。不同 lane / 不同目录天然并行。
- **已关联任务必须带来源才能读**：缺来源 → `origin-required`、错来源 → `origin-mismatch`（退出码 6），内存与重启后一致；只有旧的未关联任务保持"只给 taskId"兼容查询。
- **授递进已有会话时的结果归属（带 `--origin`）**：任务靠 `requestId`（=taskId，写进 DSH 的 `user/message.source.rpcId`）关联到**自己那个 DSH 回合**，
  只收该回合的助手文本；只有该回合并以 `completed` 结束才算成功，`aborted/blocked/error/max-tokens/interrupted/forked`
  一律是**明确失败**（部分文字放在 `partialResult`，仅内存可见；落盘的是 `status`/`error`/`reason`/`requestId`/`dshTurn`）。
  因此"会话里别的回合跑完"不会把你的任务判成完成。
- **带来源时不能用 `--steer`**：steer 会把一批请求合进同一个回合，无法为你的请求单独保证归属；会被**执行前拒绝**（`origin-steer-unsupported`，零投递）。
  旧的无来源 steer 行为保留。
- **没有证据就是未确认**：`api-session/status` 只表示 agent 是否在跑，**不是**你的请求完成的证明。
  若一直没观察到匹配回合的结束（例如快照/日志里缺前半段），到时会返回 `status: "unknown"` + `resend: false`——**不要重发**。
- **网关必须回显来源才算确认**：派活/取值的响应里必须带**匹配的** `originThreadId`；若网关接受了请求却没回显（例如中途重载/旧 handler），
  一律按"未确认、不要重发"上报（退出码 8），绝不当成功、也绝不把那种响应里的结果当精确取值。
- **超时但 `delivered: true`**：消息已在目标会话队列里 → **查原 taskId，不要重发**。
- **网关重启后**：已完成的关联任务仍能按 `origin + taskId` 取回（持久记录）；没跑完的任务会返回 `status: "unknown"` + `resend: false`（执行/交付状态未能确认，**不要重发**，也不要去猜"最近一条助手文本"）。只给来源列任务时同样：没有本实例运行上下文的记录一律显示 `unknown`，不会谎报"还在跑"。
- 不按"最近使用的对话"猜目标，也不自动重发。

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
dsh-task --list                        # 最近任务列表（可加 --origin <id> 只看本对话的）
dsh-task --status <taskId>             # 查询单个任务（含 target 回显）
dsh-task --status <taskId> --origin <id>   # 按来源精确取值（推荐；取不到时退出码 6）
dsh-task --my-tasks --origin <id>      # 列出该来源登记过的任务（找回丢失的 taskId）
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
