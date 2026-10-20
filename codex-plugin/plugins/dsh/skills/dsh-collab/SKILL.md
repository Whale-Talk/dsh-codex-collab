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
- `--steer` / `--parent <父taskId>`：仅 session 目标。**默认 `queue`**（排进官方 FIFO，等当前任务忙完再跑）；
  `--parent`（等价 `--steer --parent`）表示"**作为补充回执插进那条父任务的当前回合**"。用户已授权你在同一任务范围内**自主选择**：
  需要排队就 `queue`，需要补充/纠正正在执行的父任务就 `steer`；**用户显式指定的模式优先**。steer 必须给正确父任务（同来源/同会话/正在执行/回合可证）并自带控制鉴权，否则执行前零投递拒绝。
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
- **带来源时的 `--steer`（第四轮投递控制）**：来源绑定 steer **是支持的**，但必须是**父任务回执**——
  显式给 `--parent <父taskId>`（可选 `--expected-turn`），父任务须同来源/同会话/**正在执行且回合可证**，
  且本机要有控制 key（steer 改动既有任务，缺 key 零投递）。
  预检不通过（无父 / 父已结束 / 父还在排队 / 来源不符 / 回合不符 / 缺凭据）→ **执行前拒绝、零投递**。
  回执只报**自身**状态（`receipt-observed` / `receipt-deviated` / `receipt-unconfirmed` / `receipt-pending`，`resultScope=parent-task`），
  **不代表父任务结果、也不参与审批归属**；未观察到时 `resend:false`，父任务结果请查父 task。
  非 session 目标（worker）不走 steer。
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

## 审批委托（任务等审批时由你逐次决定，用户不在也能继续）

```bash
# 0) 只做一次：离线初始化控制凭据（仓库/工作区之外的私有目录；raw key 不回显、不上线）
dsh-task --approval-key-init           # 轮换用 --approval-key-rotate（会让全部旧 grant 立即失效）

# 1) 派活时显式开启委托（grant 与 task+origin 绑定先于 prompt；失败=零派活）
dsh-task --in "<指令>" --session <id> --origin <对话id> --delegate [--delegate-ttl 秒] [--delegate-lease 秒] [--authorization "本次授权范围"]
#   初次默认等待与下面的 --status-wait 是同一条有界等待路径：带 origin 逐次核对回显、按租约自适应认证续租、
#   遇到 needs-approval 立即 exit 9（不必先手动查 grant，也不必再调一次 --status-wait 才能续租）。

# 2) 任务等你审批时会以退出码 9 立即返回（不是失败、不是完成）
dsh-task --status <taskId> --origin <id>     # status=needs-approval 时看 needsApproval/approvalPendingCount
dsh-task --approvals --origin <id> --task <taskId> [--grant <grantId>] [--wait-approval 秒]

# 3) 逐条单次决定（approvalKey/grantId/fingerprint 都来自上一步；多余字段与参数副本一律被拒）
dsh-task --approve <approvalKey> --origin <id> --task <taskId> --grant <grantId> --fingerprint <fp> [--idem 幂等键]
dsh-task --reject  <approvalKey> --origin <id> --task <taskId> --grant <grantId> --fingerprint <fp>

# 4) 决定后继续收结果（等待期间会做认证续租）
dsh-task --status <taskId> --origin <id> [--grant <grantId>] --status-wait

# 撤销 / 在原授权窗口内显式续期
dsh-task --revoke-grant <grantId> --origin <id> --task <taskId> [--reason "…"]
dsh-task --renew-grant  <grantId> --origin <id> --task <taskId> [--extend 3600]
```

- **MCP 等价**：`dsh_task { delegate: true, authorization }` / `dsh_approvals { originThreadId, taskId, … }` /
  `dsh_approval_decide { originThreadId, taskId, approvalKey, grantId, fingerprint, decision: "approve-once"|"reject" }`；
  `dsh_task_status { wait: true, grantId }` 可阻塞轮询到终态（遇 `needs-approval` 会立即返回，等待期间认证续租）。
- **`origin`+`task` 是必填定位**（服务端还会与 pending/grant 硬核对）；它们**不是授权**，绝不能只凭它们放行。
- 控制凭据只在 MCP/CLI 内部读取并作为 `X-Dsh-Control` 头发出；raw key 不出现在参数、结果、错误或审计里。
- **看到 `needs-approval` 不要重发任务**：它是非终态，只差你对挂起项做一次决定。
- `submitted ≠ confirmed`：再查一次看到 `state=confirmed`（官方 `approval/decided=allowed-once` 已观测）才算确认；`decision-unknown` 表示确认丢失——**不要重发放行**；若官方 outcome 是 cancelled/rejected，绝不会被记成批准。
- 只接手能严格证明属于本委托的请求：无 callId / 无宿主参数快照 / 工具名不符 / turn·step 证明不了 / 不是自己那个 turn / PTC 嵌套（`…:ptc:<n>`）/ 父子混淆 / 官方 ask 身份歧义 → 一律交还人工（`next()`）；worker 与 PTC 能力如实报 false。
- 审批类退出码：`9` = 等待审批（非终态）；`0-8` 语义不变；缺本机 key / 预检不支持 → `2` 且**零派活**。

- **投递模式（queue / steer，第四轮）**：DSH 忙时由**你**按任务关系选，服务器不猜急迫程度：
  - `queue`（默认）：排进官方原生 FIFO，当前任务完成后执行；忙时也可靠接收。每个任务独立 taskId/requestId/回合/结果。
  - `steer`：**补充/纠正当前任务**时用，插进父任务的当前回合（同 turn 消费）。**必须显式给父任务**：
    `dsh-task --in "<补充>" --session <id> --origin <对话id> --parent <父taskId> [--expected-turn N]`；
    MCP: `dsh_task { deliver: "steer", parentTaskId, expectedTurn }`。父必须同 origin/同会话**正在执行**；父未开始/已结束/来源不符/回合不符 → 零投递拒绝。
  - 回执语义：有独立 taskId 与 `observedTurn`，`resultScope=parent-task`；**不等于**父任务结果，也**不签发/扩大**父 grant、不自动决定旧 pending。回执 `receipt-unconfirmed` 表示"官方已接收但没观察到落进父回合"——**不要重发**；父任务结果查 `--status <父taskId> --origin <id> --status-wait`。
  - CLI/MCP/**DSH 原生工具**都会校验控制凭据（steer 改动既有任务）：CLI/MCP 自动带 `X-Dsh-Control` 头，原生工具只读**本机已有**可信 key（绝不接受调用方传入的 raw key）；缺 key/坏 key → **零插入**。普通非委托 queue 不增加凭据前提。旧网关缺 `capabilities.delivery` → 零派活拒绝。

## 故障排查

- **模型选择（第五轮，`model:auto` 为默认）**：派活时**不用**再猜固定型号——插件会从本机**已注册** provider 目录里选并回显：
  - 缺省/`--model auto`：按真实能力（模态/上下文/effort 兼容）+ DeepSeek 偏好 + 任务类型自动选；`fast`/`pro` 仍是兼容偏好；`--model default` 表示**继承**当前选择（不覆盖）。
  - `--model <精确id> [--provider <p>]`：精确指定；同一模型名在多个 provider 出现时**必须**给 `--provider`，否则拒绝并列出候选。精确指定默认**不**自动降级，要降级须显式 `--model-fallback`；`--no-model-fallback` 可显式关闭。
  - 只读目录：`dsh-task --models`（或 MCP `dsh_models`）列出候选 pair、目录失败隔离、已知临时失效与冷却；**目录可见 ≠ 凭据/额度/远端健康已验证**，也没有质量/价格评分。
  - 失效切换边界：只按**稳定 failure.code** 分类；认证/额度/模型失效可切，限流/网络先有界重试再切；**用户取消、拒答/安全、审批拒绝、工具错误、未知插件异常都不切**。默认最多 3 个不同候选，且同 turn/step 内恢复（不重派提示、不丢已执行工具、不新建子代理）。
  - 任务状态可查 `route`（实际选择/模式/是否允许降级）与 `routeAudit`（切换次数/原因/终态，跨重启保留；只存稳定 code，无正文/密钥）。
  - **评审与编码同一契约**：`dsh_review` / `review.mjs` / 原生 `dsh_collab_review` 默认也是 `auto`（优先 DeepSeek），同样支持 `--model/--provider/--model-fallback`；`review.mjs` 还要求**显式来源**（`--origin` 或本次调用的 `CODEX_THREAD_ID`）并逐次 status 核对来源，旧网关遇到模型新语义**零派活**拒绝。`--session`/`--find`/`--cwd` 三种目标的模型参数都成对发送（`provider+model` 是一对身份，不允许只发一半）。

- 连接失败：DeepSeek Harness 未运行（网关应监听本机端口，默认 3080；挂在 web/desktop profile 时也可能就是 GUI 的端口）。
- 派 session 任务返回 `session-writer-held` / `session-busy`：那条会话被别的写入方或另一个 bridge 任务占用；稍后重试，或改用 worker 目标。
- 返回 `session-busy: owned by subagent routing`：那是子代理会话，**不能作为投递目标**；只能接普通会话。
- 返回 `session-not-activatable` / `session-archived`：该会话当前接不了（冷会话未能激活，或已归档）；请用户先在客户端打开它，或解除归档。
- 某些部署禁用了搜索（会话索引 `openAt: never`）：`--sessions` 会自动退回 `list` + 标题投影匹配，响应里的 `matchedBy` 会写 `list`。
- 读不到 `--cwd` 目录：提示用户在 Codex 设置中把该目录加入可访问/可写目录。
