# Codex → DSH 派活与回报关联方案（R0 核实 + R1 已实现）

- 日期：2026-10-12
- 仓库：`E:/11-Github/dsh-codex-collab`
- 关系：本文件是**补充方案**，不改动 `docs/DSH_TO_CODEX_MESSAGING_PLAN.md`（那份仍是 M0–M3 的原始计划，M0 结论仍为 blocked）。
- 一句话：主要使用方式收敛为 **Codex 发起任务 → DSH 执行 → Codex 按来源对话 + taskId 精确收取该任务回报**；这条链路**不依赖**"唤醒任意空闲桌面对话"。
- 状态：**R0 已核实、R1 已实现**（代码 + 文档 + 真实回归），R2 仍未做。

## 1. 范围与结论

| | 结论 |
|---|---|
| 已实现 | **R1**：派活时绑定来源对话 id，持久记录「来源对话 → taskId → 执行目标 → 状态/结果」，跨回合、跨 MCP 进程、网关重启后仍能精确收取 |
| 不做且不需要 | 不需要"唤醒任意空闲桌面对话"才能完成派活回报——按来源 + taskId 的路径**已能正确收取** |
| 未做（后续） | R2：空闲自动唤醒（M0 仍 blocked）；恢复时**重新观察**活任务（当前明确标 unknown，不猜） |
| 能力边界 | 桌面自动唤醒仍为 `canWakeIdle: false`；本条只讲派活回报的关联与收取 |

## 2. 已具备的链路（R0 核实，代码位置已逐条核对）

### 2.1 taskId：服务端生成、内存表、唯一

- 生成：`harness/dsh-bridge.mjs:82` —— `const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)`
- 分配：会话目标 `:679`、worker（`enqueue`）`:785`、评审（`submitReview`）`:824`，均写入 `taskId: uid()`。
- 内存表：`const tasks = []`（`:210`）。**淘汰改用 `harness/task-table.mjs` 的 `rememberTask`**：只在超限时淘汰**终态**任务，
  永不淘汰 `accepted`/`running`（否则完成回调/会话观察器 `find(taskId)` 找不到它），全是活任务时宁可超过 200。
- 持久记录**不受**内存上限影响（见 §3），因此"超过 200 条已完成记录后旧结果仍可查"。

### 2.2 MCP 侧按 taskId 等待与查询

- `mcp/dsh-mcp.mjs` 的 `waitTask(taskId, timeoutSec, originThreadId)`：每 3s `GET /status?taskId=…[&originThreadId=…]`；
  终态 `done|error|cancelled` **以及 `unknown`** 都立即停止轮询（不会无限等）；超时返回 `status:'waiting'`。
- `dsh_task`：`wait:false` → `{ok:true, phase:'submitted', …}`；默认等待 → `{phase:'finished'}`；
  会话目标 `delivered=true` 但报错 → `{phase:'queued-then-failed', resend:false}`；**恢复到的未知状态** → `{phase:'unconfirmed', resend:false}`。
- `dsh_task_status`：两种用法——`taskId [+ originThreadId]` 精确取值；**只给 `originThreadId`** 列出该对话登记过的任务（找回丢失的 taskId）。
- 工具**仍然是 6 个**（未新增）；`dsh_task` / `dsh_review` 的说明里明确要求**每个回合显式传当前对话 id**，并写明"不要用常驻进程环境或最近对话推断"。

### 2.3 /status 回传的字段

```
taskId, status, kind, cwd, lane, target, deliver, instruction(≤300),
result, error, reason, fallback,
delivered?, originThreadId?, associationError?, matchedBy?, candidates?,
watcher? / sawRunning?                       // 仅会话目标且仍在观察时
```

- `status` ∈ `accepted | running | done | error | cancelled`，**另加恢复专用 `unknown`**。
- 会话目标带 `target: { kind:'session', sessionId }`（**这个 `sessionId` 就是"执行方 DSH 会话"**）；worker 目标带 `target: { kind:'worker', cwd, lane }`。

### 2.4 回报回到哪条 Codex 对话

MCP 是**客户端发起**的调用：Codex 在哪条对话里调用了 `dsh_task`，工具结果就回到那条对话——**等待模式今天就能正确收取**。
`originThreadId`（来源对话 id）解决的是另一件事：**同一条对话的多次派活彼此区分**，以及**跨回合/跨进程之后还能精确取回**。

## 3. R1 实现：来源关联（已落地）

### 3.1 接口

| 位置 | 参数/行为 |
|---|---|
| `POST /api/dsh-bridge/task`、`/review` | 可选 `originThreadId`（非空字符串 ≤200 字符、无控制字符）；**非法值在执行前拒绝**（400 `invalid-origin`） |
| `dsh_task` / `dsh_review`（MCP） | `originThreadId` 显式透传；**不使用进程环境或"最近对话"推断** |
| `dsh_collab_send` / `dsh_collab_review`（DSH 侧原生工具）、WS 指令 | 同样支持 `originThreadId` |
| `GET /status?taskId=…&originThreadId=…` | 精确取值（内存优先；内存里没有则从**持久记录**恢复） |
| `GET /status?originThreadId=…`（或 `/tasks?originThreadId=…`） | 列出该来源登记过的任务（含只存在于持久记录里的） |
| `GET /tasks` | 不带来源时行为不变 |
| CLI `task.mjs` | `--origin <id>`（显式优先）→ 其次**本次调用**的 `CODEX_THREAD_ID`；`--my-tasks`、`--status <taskId> --origin <id>`、`--require-origin`；`--origin` 缺值按用法错误 |

成功/等待/终态响应都回显 `originThreadId` + `taskId` + 执行目标（`taskResponse` 统一附加）。

### 3.2 持久记录与存储

- 模块 `harness/codex-associations.mjs`；文件 `<root>/<namespace>/bindings.jsonl`（**追加型事件日志**，读取折叠成记录）。
  默认根 `~/.dsh-codex-task-assoc`（`DSH_CODEX_TASK_ASSOC_DIR` 可覆盖），namespace 由 `DSH_BRIDGE_ASSOC_NAMESPACE` 指定（默认 `default`）。
- 记录字段：`{originThreadId, taskId, kind, target, profile, status, createdAt, updatedAt, delivered, result, error, reason, stopReason}`。
- **执行前落盘**：`bind` 在派活 / 投递 prompt **之前**调用；**失败即拒绝执行**（映射为 `association-bind-failed`）——绝不出现"执行了却没绑定"。
- **终态写回**：`onChildEnd`（worker/review 完成）、`settleSessionTask`（会话完成/失败/取消/超时）、fallback 完成、异常路径、
  `pollOne` 静默超时、`/cancel` 两条分支，全部调用 `persistTask`；写失败记到任务上的 `associationError` 并打日志（**不静默**）。
- **绑定不可改投**：同一 taskId 换来源 → `origin-conflict`。
- **隔离与路径安全**：namespace 只允许 `[A-Za-z0-9._-]{1,64}` 且排除 `.`/`..`；`originThreadId`/`taskId` **从不参与路径拼接**。
  日志追加型 + taskId 全局唯一 ⇒ 多个网关/多 profile 共用同一命名空间也不会互相覆盖记录；需要分隔时用命名空间。
- **读写失败明确报错**：读不动 → `store-unreadable`；文件有内容但一行都解析不出 → `store-corrupt`；**绝不降级成空记录**。
  写入串行化复用 `harness/fs-lock.mjs`（与收件箱**同一把独占锁算法**）。
- 写入前修**记录边界**（末字节不是换行就补一个），残尾不会吞掉后续写入。

### 3.3 用户流程（含异常处置）

1. **定目标**：确定执行方（`--session`/`--find` 只读查找；**不按"最近使用的聊天"猜**）。
2. **派活并带来源**：`--origin <当前 Codex 对话 id>`（MCP：`originThreadId` 参数）——执行前完成持久绑定。
3. **等待或后查同一个 taskId**：`--status <taskId> --origin <id>`；忘了 taskId 就用 `--my-tasks --origin <id>` 找回。
4. **拿到 done → 验收 → 继续**：读 `result`，必要时 `dsh_review` / `dsh_read_file`。
5. **异常处置**：
   - 超时但 `delivered: true` → 消息已在目标会话队列里 → **查原任务，绝不重发**。
   - **网关重启/新实例**：已完成 → 按 `origin+taskId` 取回结果；没跑完 → `status: "unknown"` + `resend: false` + 原目标 + 已知 `delivered`，
     **不谎报完成、不重新观察、不自动重发**（要确认就自己去看目标会话/工作目录）。
   - 错来源/缺来源 → 明确拒绝（`origin-mismatch` / `origin-required`），**绝不返回别的对话的结果**。
   - 取消：`/cancel` 支持可选 `originThreadId`；已关联任务被别的来源取消 → 拒绝。

### 3.4 会话任务的精确请求回合关联（带来源时）

会话目标不能再用"派发前基线 + 全会话 running/idle"来收结果——那会把**别的请求**的输出算给当前 taskId。
带来源的会话任务改为**按请求关联回合**（依据本机 controller 0.2.0-rc.2 实测字段）：

| 事实 | 做法 |
|---|---|
| `prompt.requestId` 会写进 `user/message.data.source.rpcId` | 用 `taskId` 当 `requestId`；匹配 `rpcId === taskId` 的那条 user 消息 = 本请求 |
| **`user/message.data.turn` 不存在** | 按 `seq` 有序跟踪"已 `turn/start` 但未 `turn/end`"的回合；rpcId 匹配时归到当时**未闭合**的那个 turn |
| `assistant/message.data = {turn, step, message:{content}}` | 只收 `turn === 本请求 turn` 的助手文本 |
| `turn/end.data = {turn, reason:{kind}}` | 本请求的结束依据；`kind ∈ completed/aborted/blocked/error/max-tokens/interrupted/forked`，**只有 completed 算成功**，其余明确终态失败（保留部分文字为 `partialResult`） |
| follow 开场 = `{type:'snapshot', records:[{type:'event',event}], …}`（不是 `snapshot.events`） | **必须检查 records**：快任务可能在派发与订阅之间就跑完，答案只在这个快照里 |
| `api-session/status` 只表示 agent 是否 running（连续跑 queued turn 时可能没有新的 `running=true`） | 只当作"读一次日志"的机会；**绝不是**某请求完成的证明；quiet/总预算到期而无匹配 `turn/end` → 报未确认（`resend:false`），绝不猜 done |
| 事件可能被 snapshot / 轮询 / live 重复投递 | 按 `seq` 去重，但**只标记"真正产生效果"的事件**：当时因为还没关联上自己 turn 而无法使用的事件必须能在完整日志回填时被重新消费（否则快照缺前半段会永久丢答案） |
| `steer` 会把整批 next-step 合并进同一个 turn | 带来源的会话派发**执行前拒绝 steer**（`origin-steer-unsupported`，零 prompt）；旧的无来源 steer 行为保留 |

**回显与持久化（按最终实现，区分落盘与仅内存）**：

- **落盘**（关联记录 `bindings.jsonl`；`/status` 在内存分支与恢复分支都回显）：`originThreadId`、`taskId`、`kind`、`target`、
  `status`、`delivered`、`result`、`error`、`reason`、`stopReason`、`requestId`（=taskId，会话任务）、`dshTurn`（匹配到的回合号）。
- **仅内存可见**（活任务的 `/status`，不落盘）：`turnEndKind`、`partialResult`，以及未确认路径的 `resend`/`note`。
  恢复分支不带这三项，而是按记录状态自己给出：终态记录回放 `status`/`result`/`error`/`reason`；非终态记录合成
  `status: "unknown"` + `reason: execution-state-unconfirmed` + `resend: false` + `note`（这是**恢复时的结论**，不是从盘里读出的字段）。

**未验证/限制**：相关性依赖有序日志（若日志缺 `turn/start`，只能归到最近未闭合的 turn）；`api-session/error` 不带 requestId，因此**不**用它判定某个排队请求失败；"恢复后重新观察活任务"仍未实现（只报未确认）。

## 4. 验收（本轮真实跑过）

### 4.1 契约收紧（独立复现脚本 `review-r1-contracts.mjs` 曾 2/8，现 **8/8**）

| 契约 | 实现 |
|---|---|
| 显式非法来源零执行 | 只有**字段未传/undefined** 才是旧的无关联模式；显式 `''`/`null`/数字/布尔/数组/对象/纯空白 → `invalid-origin`，400 且零执行零关联。MCP 与 CLI 同样先本地拒绝（不丢字段、不改用 ENV；CLI `--origin` 缺值/下一项是旗标/空值 → 退出码 2，**请求前**报错） |
| 已关联任务必须带来源 | **内存与磁盘一致**：缺来源 → `origin-required`、错来源 → `origin-mismatch`，都不返回 `result`/`instruction`；`/cancel` 同样检查。`openAssociations.fetch` 失败时**不再带出 record** |
| 同通道并发必须可归属 | 同一 `cwd+lane`（评审=同目录）有在途任务时，第二个明确 `worker-bucket-busy` / `reviewer-bucket-busy` 拒绝：**零 followup、零二次执行**，绝不用"桶里最老的 pending"去猜归属。不同 lane 照旧并行；上一任务结束后可继续复用同一子代理 |
| 旧网关零执行 | `/status`（无参数）、`/tasks`、`/debug` 上报 `capabilities.originBinding.supported/version`；MCP/CLI 带来源时**先只读核验**（GET，不派活），不支持则拒绝且**一个派活 POST 都不发**。按来源查询也不把旧网关的普通响应当成精确恢复 |
| 列表不谎报 | 只给来源列任务时，本实例没有运行上下文的非终态记录一律 `status:"unknown"` + `persistedStatus` + `resend:false` + 说明（与精确查询同一套投影） |

### 4.2 端到端（真实进程/真实请求）

**独立验收脚本**（Codex 侧，正向契约测试）：`review-r1-contracts.mjs` **12/12**、
`review-session-correlation.mjs` **4/4**（含"排队请求忽略先前回合"、"只有自己 turn/end 才完成"、
"自己回合 error/blocked 不得 done"、"snapshot.records 里的快速完成"、"快照缺前半段回填"、
"旧网关零执行拒绝"、"能力通过但网关未确认来源 → 未确认 + 禁止重发"）。

`test/codex-association-e2e.test.mjs` —— **真实 `http.Server` + 独立 MCP 进程 + 独立 CLI 进程**：

- 回合 1（MCP 进程 A）带 `originThreadId` 派活 → 执行前落盘；**环境里故意放一个 `CODEX_THREAD_ID`，MCP 不得采用它**（断言来源仍是显式传的那个）。
- 回合 2（**另一个** MCP 进程）：只给来源 → 列出该任务；再按 `origin+taskId` → 取回结果；错来源 → `origin-mismatch` 且无结果；
  缺来源 → `origin-required` 且无结果；非法来源 → `invalid-origin` 且零派活。
- **网关新实例**（同持久 root、新端口、全新内存表）：已完成 → `done` + 结果（`recovered: true`）；未完成 → `unknown` + `resend:false` + 原目标；
  缺来源 → `origin-required`；**新实例零执行**（`starts`/`prompts` 均为 0）。
- CLI：`--origin` 派活 → 新进程 `--my-tasks` 找回 → `--status … --origin` 取结果；缺来源/错来源退出码 6；无来源 `--my-tasks` 退出码 2；
  `--require-origin` 拒绝派活且零派活；`CODEX_THREAD_ID` 兜底可用；无来源的旧调用仍兼容；`--origin` 缺值按用法错误。
- 测试卫生：CLI 一律**异步 spawn**（网关 HTTP 服务器与测试同进程，同步 spawn 会自锁），MCP 收尾**等待子进程 close**，
  失败路径也 `finally` 关网关/杀子进程（宿主与清理统一在 `test/helpers/dsh-host.mjs`）。

### 4.3 项目内回归

`test/codex-r1-contracts.test.mjs`（8 项，把独立场景固化：C1 非法来源、C2 缺/错来源、C3 通道 busy + 不同 lane 并行 + 评审 busy、
C4 旧网关零执行 + 能力上报、C4b 能力上报放行、C4c 能力通过但未确认来源 → 未确认 + 禁止重发、C5 列表 unknown 语义、CLI 严格参数）；
`test/codex-session-correlation.test.mjs`（8 项，真实 SDK 字段：排队请求忽略先前回合、自己 turn/end 才完成且不需要新 running、
error/blocked/aborted/max-tokens 不得 done、snapshot.records、重复投递不串文本、快照缺前半段回填、无匹配 rpcId → 未确认、steer 拒绝 + 旧路径保留、worker/取消不受影响）；
`test/session-target.test.mjs` 另有 5 项关联器纯函数单测；
`test/dsh-bridge.test.mjs`（13 项）与 `test/codex-associations.test.mjs`（13 项）另覆盖：执行前落盘、worker/评审/取消写回、
**200+ 已完成记录后旧关联结果仍可查且活关联任务仍能完成**、**关联存储不可用 → 拒绝派活（绝不假成功）**、绑定不可改投、
命名空间隔离、fetch 失败不泄漏 record、真多进程并发 bind、任务表淘汰不丢活任务。

## 5. 验收重点（对应关系）

| 要求 | 实现/证据 |
|---|---|
| 两个来源的任务不串号 | 错来源一律 `origin-mismatch`；e2e 用两个来源分别派活并交叉查询 |
| 同一对话多个任务可区分 | 靠 taskId；`--my-tasks` 列出该来源全部任务 |
| 超时继续查原 taskId、不重发 | `waiting` + `queued-then-failed(resend:false)` + `unknown(resend:false)` |
| 不按"最近聊天"猜目标 | 来源必须显式；缺来源一律拒绝；代码/测试/文档无任何真实对话 id 默认值 |
| 对话 id 负责归属、接收工具负责收取 | `originThreadId` 归属 + `dsh_task_status`/`--status` 收取 |
| 不把"支持来源"当成默认 | 派活/查询前只读核验 `capabilities.originBinding`；旧网关零执行拒绝 |
| 结果归属不能靠猜 | 同通道在途任务时明确 busy 拒绝（不 followup、不猜 pending） |
| 自动唤醒能力 | 仍为 `false`（未实现，未宣称） |

## 6. 分阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| **R0** | 核实现有 taskId 回报链路并写清边界 | ✅ 完成 |
| **R1** | 显式来源元数据 + 持久关联记录 + 跨回合/跨进程/重启恢复 + CLI/MCP/文档 | ✅ **本轮完成** |
| **R2** | 只有在明确需要"空闲自动唤醒"**且**存在受支持桌面入口时，才接回 M0–M3；可另加"重新观察活任务" | ⏳ 未做（M0 仍 blocked） |

## 7. 明确不做 / 未验证

- 不新增第 7 个 MCP 工具；不改动既有六个工具的语义与既有参数行为。
- **`originThreadId` 是关联元数据，不是认证/授权凭据**：本机 loopback 调用者知道 taskId+origin 就能查；本包不做权限模型。
- **未实现"重新观察活任务"**：恢复到的未完成任务只报 `unknown`，不读"最近助手文本"去猜。
- 不做空闲唤醒、不做自动重发、不按最近/标题/时间猜来源对话。
- **通道忙时的取舍**：同 `cwd+lane` 有在途任务就拒绝第二条（宁可让调用方等/换 lane，也不让完成结果归属变成猜测）；
  这是有意的行为收紧，不是 bug。
- **能力握手靠网关自报**（`capabilities.originBinding`），不靠包版本号：从旧版本升级到本版本后，客户端会自动放行；
  若 profile 里装的是旧插件，客户端会拒绝来源模式（旧的无来源调用不受影响）。
- 关联日志不自动清理（追加型，增长很慢）；归档属后续工作。
- 不写入任何真实对话 id 作为默认值（代码/测试/文档均无硬编码）。

## 8. 与 standalone inbox 的关系（并列，不互相替代）

- `mcp/codex-inbox.mjs` + `harness/codex-outbox.mjs` 的**收件箱**是将来"存放待收消息"的基础设施（持久、幂等、按序、重启可恢复），
  与 **来源关联的 taskId 工具回报路径并列**，不是它的替代品；两者现在**共用同一套独占写锁算法**（`harness/fs-lock.mjs`）。
- 因此：**"桌面自动唤醒尚未完成"不等于"已有派活回报失效"**。前者是"DSH 主动叫醒 Codex"的能力（blocked）；
  后者是"Codex 派活后按来源 + taskId 收结果"的能力（**已工作**）。
- 收件箱的当前能力仍如实标注：`deliveryMode: 'inbox'`、`canWakeIdle: false`。
