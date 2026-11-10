# Codex 单次审批委托 · M0 工程审查与官方接口取证

- 日期：2026-10-15
- 仓库：`E:/11-Github/dsh-codex-collab`（基线 `383528c` / npm `0.1.9`）
- 审查对象：`docs/CODEX_DSH_APPROVAL_DELEGATION_PLAN.md`（本文件只读它，未改动）
- 本轮动作：**只读取证 + 写本文件**。未改任何生产代码、未安装、未改权限/preset/never、未重启客户端、未读凭据或用户其它会话存储。
- 证据来源（全部只读）：本机官方安装包 `D:/Program Files (x86)/DSH/resources/app.asar`；提取/扫描工具在 `E:/07-Workspace_codex/.tmp/dsh-approval-protocol/`（`scan-approval.mjs`，只读 asar，产物写 `.tmp`）。**不把任何 SDK 文件复制成运行时依赖。**
- **宿主版本说明（2026-11-06 追记）**：本文件取证时宿主为 SDK **0.2.0-rc.2**，故下文行号是当时基线。DSH 已升级到 **0.2.2-rc.1**：`ApprovalService` 改为经 `ctx.sessionProjections` 的 `approvalStateDefinition` 投影读 policy/turnOpen（`approval/request` 瀑布、官方 `approval/asked|decided` 审计、`never` 先拒、signal→cancelled、非法返回归一 unavailable 等**契约未变**）。本插件的 `test/approval-native.test.mjs` 已改用真实 `SessionProjectionRegistry` + `Service.init` 复验同一组断言；跨版本入口存在性由 `test/dsh-compat.test.mjs` 守卫。

## 0. 结论摘要

| # | M0 必答项 | 结论 |
|---|---|---|
| 1 | hook 注册 API/优先级/不吞 next/仅本任务生效 | **可实施**：`ctx.on('approval/request', cb, {prepend:true})`（boolean 简写亦可），注册序执行、不调 `next()` 即否决全链、默认 next=`unavailable`；靠"严格谓词 + 始终 `next()`"不吞人工与其它 answerer |
| 2 | req 字段/参数/turn·step·callId/官方 id/worker child | **req 无参数**（官方类型只有 agent/toolName/callId?/reason?/displayReason?/signal?）；参数须经 `tools/pre-execute`（`callId`+`arguments`）或日志 `tool/call`（`turn/step/callId/arguments`）按 `callId` 关联；官方 id **answerer 永远拿不到**（请求内 `randomUUID()`），只能事后观测日志，**worker child 绑定未证明 → 报不支持** |
| 3 | 单次 allow 与取消/超时/decided/卸载/已在 UI 等待 | 单次与"由那一次调用消费"是官方语义 ✓；官方**无超时**（UI 可无限等）；已在 UI 等待的请求**不能自动接手**——只能人点 UI"委托"或我们 prepend 抢先；卸载由 cordis fiber 自动摘监听（fiber 卸载移除，链上数组副本仍安全） |
| 4 | 控制授权信任链 | 必需：**控制凭据 + 任务能力**双层；`origin/task/reason/loopback` 一律是定位/文案，不是认证；凭据不入仓库/提示/日志/工具结果；审计只存哈希 |
| 5 | 无重启/不改 preset 的 live canary | **本轮做不到**（需新宿主插件代码 → 装包+重启 profile）；替代边界 = `.tmp` 内用**真实抽出的 cordis/user-approval/scope/sandbox** 跑 native harness；未来真 canary 的加载前提与替代验证在 §3.5 |
| 6 | 方案必修建议 + M1 拆分 | 6 条必修（§3.6，其中"参数来自正式 req"是**必须改**的错误假设）；M1 文件拆分见 §3.6 |

---

## 1. 取证方法与证据等级

- **[V 已验证-官方源码]**：直接读到 asar 内官方 JS 的对应行，语义由代码或 JSDoc 明确写出。
- **[I 强推断]**：由已验证代码结构必然推出，但未在运行时观察过。
- **[U 未验证]**：M0 无法证明，需 M1 native harness 或 live canary。
- 行号引用格式：`包名/lib/文件.js:行`（asar 内路径，形如 `dsh/node_modules/@deepseek-ai/<pkg>/...`）。

关键提取物（已留在 `.tmp` 供 Codex 独立复核）：
`dsh-user-approval__lib__index.js`、`dsh-experimental-auto-review__lib__index.js`、`dsh-api-session-controller__lib__index.js`；本轮回执新增扫描脚本 `scan-approval.mjs`（含 `--range`/`--list` 模式）。

---

## 2. 官方审批接缝（逐项证据）

### 2.1 服务时序与结果语义 [V]

`@deepseek-ai/dsh-user-approval/lib/index.js`：

- **L30–35** `OUTCOMES = ["allowed-once","rejected","cancelled","unavailable"]`；**L37** `APPROVAL_POLICIES = ["ask","never"]`。
- **L128–144 `request(req)`**：
  1. `session = req.agent.session`（L129）→ **`req.agent.session.id` 是从 req 自身可得的严格会话身份**；
  2. `hasOpenTurn(session)` 不满足即 **throw**（L130，错误文本说明审计对必须被 turn 包住）；
  3. `id = ApprovalRequestId(randomUUID())`（L131）→ **官方审批 id 在服务内部生成，answerer 永远拿不到它**；
  4. `session.append("approval/asked", {id, toolName, callId?, reason?})`（L132–137）；
  5. `outcome = await this.decide(req, session)`（L138）——**先记 asked，再进 waterfall**（→ 答复者被调用时 `approval/asked` 已在日志里，可事后观测到官方 id）；
  6. `session.append("approval/decided", {id, outcome})`（L139–142）→ `outcome` 是唯一可信的采纳证据。
- **L172–189 `decide(req, session)`**：
  - `signal?.aborted` → `'cancelled'`（L174）；
  - `effectivePolicy === 'never'` → `'rejected'`（L175），**在 waterfall 之前**；
  - 否则 `ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))`（L176）→ **默认 next 返回 `unavailable`（fail closed）**；
  - 非法返回值或 throw → `'unavailable'`（L176）；存在 `signal` 时与之赛跑，先到先得（L177–188）。
- **L49–56 `hasOpenTurn`**：从 `session.seq-1` 倒序找最近的 `turn/start`（遇 `turn/end` 即止）。
- 包描述（`package.json:3`）：*"one-shot permission decisions … over the approval/request waterfall, **fail-closed by default**"*。

**含义**：官方契约只有"这一个动作"的一次性许可；链上任何不回 `next()` 的答复者都会**连内置 `unavailable` 一起否决**，因此我们的答复者必须自己负责"不接管时放行"。

### 2.2 公开类型与签名（req 有什么、没有什么）[V]

`dsh-tool-cordis/lib/types/api-catalog.js`：

- **L4475–4476 `ApprovalRequestEvent`**：`{ agent, toolName, callId?, reason?, displayReason?: {en, [locale]}, signal? }`
- **L4471–4472 `ApprovalRequest`**：`extends ApprovalRequestEvent`，**字段完全相同**（无参数、无 cwd、无 turn/step）
- **L3852–3854 官方签名**：
  `'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>`
- **L7552 `ToolExecutionInput`**：`{ callId, rootCallId?, name, schema?, arguments, … }`（**参数在这里**）
- **L7544 `ToolExecution`**：`extends ToolExecutionInput` + `{ rootCallId, token }`
- **L4236–4238 `tools/pre-execute` 签名**：`(this: Scoped<ToolRuntime>, exec: ToolExecution, next) => Promise<PreToolDecision>`
- **L6444 `SessionEventMap`**（同一文件）：
  - `'tool/call': { turn, step, callId, name, arguments: string }`
  - `'tool/result': { turn, step, message, error? }`
  - `'turn/start' | 'turn/end {turn, reason}' | 'step/start {turn,step}' | 'step/end {turn,step}'`

**结论**：**审批 req 里没有参数**；参数与 turn/step 有两条合法来源（见 §3.2）。

### 2.3 注册 API、顺序与优先级 [V]

`@deepseek-ai/cordis/lib/index.js`：

- **L371–380 `on(name, listener, options)`**：`options` 是对象时透传；**boolean 简写即 `prepend`**（L372）；`fiber.assertActive()`；文档 L363–364："**listener 在 fiber 卸载时自动移除**；fiber 已 dispose 则抛 `INACTIVE_EFFECT`"。
- **L335–345 `register`**：`options.prepend ? "unshift" : "push"` → **prepend = 数组最前 = 第一个执行**；返回 disposer（effect 标签可诊断）。
- **L317–325 `waterfall`**：`cbs = dispatch(...)`；`next = () => (cbs.shift() ?? inner)(...args)` → **按注册顺序执行**；JSDoc L307–312："listeners run outermost-first；**不调用 `next()` 的监听者否决整条链，包括内置行为**"；最后一个参数是内置 next。
- **L258–264 `dispatch`**：先取 `thisArg`（= `scopeTarget(req.agent, req.agent)`），再按 `thisArg[Context.filter]` 过滤 hooks，然后 `map(callback)`（**顺序保持**，是数组副本，shift 不污染注册表）。
- **`dsh-scope/lib/invariant.js:22`**：`"approval/request": (args) => args[0]["agent"]` → **该事件的 scope 键是请求的 agent**。

**回答 M0 #1（可实施部分）**：
- 注册：`ctx.on("approval/request", handler, { prepend: true })`（挂在宿主 root ctx，用 `ctx.effect(() => disposer)` 生命周期管理）。
- 优先级：prepend 能保证我们**先于**桌面 UI/ACP 拿到请求；不 prepend 则排在已注册者之后。
- 不吞 next：**谓词不成立一律 `return next()`**；内部异常也 `catch → return next()`（**不要 throw**：`decide` 的 `.then(_, () => 'unavailable')` 会把 throw 变成 `unavailable`，那会**跳过人工 UI**，比放行更糟）。
- 仅本任务生效：谓词 = 控制凭据 + 有效任务 grant + **`req.agent.session.id` 等于受托会话** + `req.callId` 存在 + pre-execute 快照存在且指纹一致（见 §3.4）。[I] root 注册会被 scope 过滤保留（ACP/UI 均以 root 注册且能收到请求，实证支持 root hook 可达 [I]）；`agent.ctx` 范围注册可作加固，但相对 UI 的顺序仍取决于注册序，故**不依赖它，只依赖严格谓词**。

### 2.4 已存在的答复者完整清单与"UI 委托"路径 [V]

全 asar 扫描 `approval/request`：**只有两个答案者**（服务侧 `waterfall` 调用点、类型目录、invariant、remote 声明除外）：

1. **ACP 适配器** `dsh-acp/lib/index.js:1116–1139`：
   ```js
   ctx.on("approval/request", (request, next) => {
     const record = ownedRecord(request.agent);
     if (record === void 0 || request.callId === void 0) return next();   // 不是我的会话/无 callId → 放行
     … conn.request(session.requestPermission, {toolCall:{toolCallId:callId}, options:[allow-once, reject-once]})
       .then(({outcome}) => outcome.outcome === "cancelled" ? "cancelled"
                          : outcome.optionId === "allow-once" ? "allowed-once" : "rejected");
   });
   ```
   ⇒ **官方参考实现也在无 `callId` 时放行 `next()`**；只给 `allow-once`/`reject-once` 两个选项。
2. **桌面 UI** `dsh-client-ui-approval/lib/client.js:355–357` → `answerApproval`（**L284–310**）：
   - `ctx.sessions.scopeOf(owner)` 无会话 → **`return next()`**（L286）；
   - 构造 `PendingApproval({toolName, callId?, reason?, displayReason?, signal?})` 并 `await pending.result`（L301）——**等人工选择**；
   - **L303：`if (pending.isDelegation(error)) return await next()`** ⇒ UI 存在"委托"**内部协议路径**（`registerPendingInteraction` 回调在 L294–297 调 `pending.delegate()`）。**修正（Codex 复查）**：同文件渲染层 L118–134 只渲染"拒绝 / 允许一次"，**没有已证实的"委托"按钮**——不能把内部协议路径说成人工可点的 UI 按钮；
   - `finally { remove(); completed.resolve() }`（L306–309）。
   - 注册方式 `ctx.remote.$on("approval/request", …)`（L355）⇒ UI 的 hook 经远程通道在宿主 root ctx 注册（早于我们的插件时排在前）。
   - 另有快捷键：`approval.allow`=Enter、`approval.reject`=Esc（L322–341）。
3. 声明面：`dsh-api-remotes/lib/types/remote-events.js:14` `{ event: 'approval/request', mode: 'waterfall' }`。

**回答 M0 #3 中"已在 UI 挂起的旧请求能否接手"**：
- **不能自动接手**。waterfall 是**每次 `request()` 调用时现场组合**的链条；UI 在链上时它 `await pending.result`，**下游（我们）在它调用 `next()` 之前根本不会被调用**。
- 合法接手途径只有两条：
  1. 我们**注册在 UI 之前**（`prepend`），对该请求直接决定 → UI 根本不弹（无人值守目标需要这条）；
  2. UI 走到其**内部 delegate 协议路径**（`isDelegation → next()`）把请求交棒 → 轮到我们（渲染层无已证实按钮，仅协议可达）。
- 若 UI 是等待方且无人触发其内部 delegate 路径，请求会**一直挂着**（官方无超时，见 §3.3）。

### 2.5 真实 ask 形状（沙箱升级路径）与 reason 的可信度 [V]

`dsh-sandbox/lib/index.js`：

- **L16–20 JSDoc**：通道是结构型 `EscalationAsk`；**"工具层拥有 agent、call id 和 tool name，并 `close over ctx.approval.request(...)` 把闭包下传"**——即 ask 由工具层发起，参数由工具层提供。
- **L99–123 `approveEscalation`**（唯一权威顺序，fail-closed）：
  - L101：`mode === effectiveMode` → 不需要 ask；
  - L102：非严格更宽 → throw；
  - L103–104：**无 approval 服务或无 agent → throw（fail closed）**；
  - **L105–115 真实 ask**：
    ```js
    await approval.approver.request({
      agent, toolName, callId,
      reason: `escalate sandbox to ${mode}: ${justification}`,
      displayReason: { en: …, zh: … },
      ...approval.signal ? { signal: approval.signal } : {}
    });
    ```
  - L116–122 结果消费：`allowed-once` → 返回 mode（**由"那一次调用"消费**）；`rejected/cancelled/unavailable` → 各自 throw，任务立即失败（fail closed）。
- 配对校验 `validateEscalationArgs`（L51–55）：`sandbox_permissions` 与 `justification` 必须成对且非空。
- **`reason`/`justification` 来自模型写的文本**（`dsh-tools/lib/types/ptc.js:62`："Reason this complete program needs wider access, **shown to the user**"）⇒ **永远不可作为授权依据**（方案 §5 已要求，证据坐实）。

### 2.6 PTC 与 native 走同一道 pre-execute 门 [V]

`dsh-tools/lib/types/ptc.js`：

- **L61–62**：PTC 工具声明 `sandbox_permissions`（枚举 `ESCALATION_TARGETS`）+ `justification` → **PTC 同样会触发升级 ask**（走 §2.5 同一 `approveEscalation`）。
- **L81**：*"A sandbox escalation approves **this complete program for one execution only**. **Nested tools retain their own policies and approvals.**"*
- **L71**：时间预算"includes **nested tool and approval waits**"。
- **L345 / L504**：*"ordered **pre-execute**"、"**pre-execute waits for this resolution, as under the native**"* ⇒ **PTC 与 native 共用同一道 `tools/pre-execute` 门**，参数快照对两者同样可用 [V 结构 / U 运行时]。

**含义**：`tools/pre-execute` 快照钩子对 native 与 PTC 都能拿到 `callId + name + arguments`；但 **PTC 的 callId 嵌套/`rootCallId` 关系与 ask 的对应尚未运行验证 [U]** → M1 前按"参数可捕获、答复者绑定待证"报告。

### 2.7 日志字段 → turn/step/参数的关联路径 [V]

- `approval/asked` 持久字段：`disposition(["id","toolName"], ["callId","reason"])`（`dsh-session-format-v0-to-v1/lib/index.js:34-35`，`dsh-session-persistence-jsonl/lib/worker.cjs:6666` 同）；`approval/decided`: `["id","outcome"]`（同处 :35/:6667）⇒ **日志里没有参数**。
- `tool/call` 持久事件带 `{turn, step, callId, name, arguments}`（§2.2 L6444）⇒ **`approval/asked.callId → tool/call` 即可取到 turn/step/参数**（参数为序列化 string）。
- 时序 [V]：`approval/asked` 在 `decide()` 之前 append（§2.1）⇒ **答复者被调用时，asked 已在日志里**；`tool/call` 是否恒早于工具体内 ask ⇒ [U，M1 native 确认]。

---

## 3. 六项必答结论

### 3.1 hook 注册：API、优先级、不吞 next、仅本任务生效

- **API**：`ctx.on("approval/request", (req, next) => …, { prepend: true })`（boolean 简写 `true` 等价）[V]；用 `ctx.effect(() => disposer)` 管理卸载 [V]。
- **优先级**：`prepend → unshift → 数组首位 → 最先执行**；否则按注册序（晚注册者靠后）。桌面 UI 经 `ctx.remote.$on` 注册、ACP 在其插件 apply 时注册，均可能早于我们 ⇒ **要无人值守必须 prepend** [V 结构]。
- **不吞人工 next / 其它 answerer**（三条硬规）：
  1. 谓词不成立 → `return next()`（含：无 grant、非受托会话、`callId` 缺失、无 pre-execute 快照、指纹不符、grant 过期/撤销、凭据缺失）；
  2. **内部异常一律 `catch → return next()`**，不 throw（throw 会被 `decide` 归一成 `unavailable`，**跳过 UI**）[V 推论]；
  3. 永不写 `approval/asked|decided`（自己记日志 = 伪造 decided，方案 §3 C 已否决）、永不 `setApprovalPolicy/setPolicy`（那是 `dsh-permission-presets` 的职责，`dsh-permission-presets/lib/index.js:223`）。
- **仅对显式关联 task 生效**：谓词以 **`req.agent.session.id`** 为会话身份（从 req 自身取得 [V §2.1]），必须 ∈ 当前持有有效 grant 的受托会话集合；再叠加 origin/task/grant/凭据/指纹。**只靠 scope 注册不够**（root 注册也会收到请求），**只靠谓词又已足够** ⇒ 谓词是唯一信任点，必须有负向测试。

### 3.2 req 字段、参数绑定、官方 id、worker child

| 问题 | 结论（等级） |
|---|---|
| req 真实字段 | `agent, toolName, callId?, reason?, displayReason?, signal?`（无参数/无 cwd/无 turn·step）[V §2.2] |
| 实际参数从哪来 | ① **`tools/pre-execute` 快照**：`{callId, name, arguments, rootCallId}`，执行前捕获、结构化、native/PTC 同门 [V §2.6]；② **日志 `tool/call`** `{turn, step, callId, arguments:string}` 按 `asked.callId` 关联 [V §2.7]。②是①的重启后备，但两者都必须**按 callId 精确匹配**，不得按"最近一次"猜 [V 方案 §4.3] |
| turn/step 绑定 | 取自 `tool/call.turn/step`；实时可用 `hasOpenTurn` 同款倒序规则（与本仓 R1 已实现的请求→turn 关联一致）[V] |
| 官方 id 映射 | **answerer 永远拿不到 id**（`randomUUID()` 在 `request()` 内）[V]；因 `asked` 先于 `decide` append，可**观测日志**按 `toolName+callId+openTurn` 匹配到官方 id，但这是**推断不是契约** ⇒ 审计里标 `officialId: observed|omitted`，**映射失败就填 omitted，不阻塞决定**（方案 §4.3 "可证实才填"保持，补上实现口径）[V+I] |
| `callId` 缺失 | 官方类型可选；ACP 与我们都必须 `return next()` [V §2.4] ⇒ 该请求**不支持委托**，报 `unsupported`，不猜 |
| worker child 绑定 | **未证明 [U]**：worker 目标的执行体是连续子代理，bridge 只有 `childId` 与 owner agent；**没有已验证的 `childId → Agent` 取回路径**，更没有"req.agent 即该 child"的证据。⇒ **M0 判定：worker 目标报不支持**（capabilities 置 false），除非 M1 先证明；session 目标可用 `req.agent.session.id` 严格匹配 [V]。这与方案 §4.2 "证明不了的目标如实报不支持"一致 |
| PTC | 参数快照可用（同门 pre-execute）[V]；**ask↔PTC callId 对应未验证 [U]** ⇒ 先报"参数可捕获、绑定待证" |

### 3.3 单次 allow、取消、超时、decided、卸载、UI 已挂起

- **单次 [V]**：`allowed-once` 是唯一许可；`approveEscalation` 返回值"consumed by the one call that asked"；包描述 "grants apply only to the requested action"；PTC 升级"one execution only"。⇒ **没有"批准后续同类调用"的官方语义**，我们的 grant 也不能扩大到未请求动作（方案 §4.5 一致）。
- **取消 [V]**：`signal.aborted → 'cancelled'`；与 answer 赛跑先到先得。父任务取消/turn 结束传入 signal 即生效；我们 answerer 必须监听 `req.signal` 及时停手并 `next()` 或退出。
- **超时 [V 缺口]**：**官方没有超时**。UI 可无限等待；我们 answerer 若挂住则整条 ask 挂住。⇒ 方案 §5 的租约/TTL 必须由**我们自己**实现：到期 → `return next()`（交还下游/UI 人工链），下游也没有则得 `unavailable`（fail closed）。**到期绝不能返回 `allowed-once`**，也不能靠 throw（会跳过 UI）。
- **官方已决定 [V]**：同一次 `request()` 链内只会有一个答复者返回值（链式短路）⇒ 不存在双决定；风险只在**桥接侧状态**（我们以为 pending，官方已 `decided`，例如人工在 UI 回答或 signal 取消）。⇒ 监听 `approval/decided`（含 `asked.id`）做 `superseded/confirmed` 收敛，**决定已提交但未见 decided → `decision-unknown`，不重发放行**（方案 §4.6/§5 保持）。
- **卸载 [V]**：`ctx.on` 的监听在 **fiber 卸载时自动移除**（cordis L363–364）；`dispatch` 已把 callback 数组**复制**，已进入链条的请求仍会被调用 [I]。⇒ 卸载语义：**新请求不再到达我们**（安全）；在途回调须在 dispose 后**只 next()/或完成已提交的决定**，并撤销在途 grant（M1 用 `ctx.effect` disposer 收口）。
- **已在 UI 等待的旧请求 [V]**：**不能自动接手**——要么 prepend 抢先（先于 UI 拿到请求），要么 UI 自己走内部 delegate 协议路径把请求交棒（§2.4；渲染层无已证实按钮）⇒ 方案 §4.1/§5 必须写明这条限制（见 §3.6 修正 #6）。
- **多请求并发 [I]**：链是每次调用独立组合的；同一时刻多个 ask = 多条链并行，各由自己的 signal 赛跑 ⇒ 需按 (session, callId) 分别建快照，一条一个结论。

### 3.4 最小可实施的控制授权信任链

威胁模型要点（均被本轮证据坐实）：
- 循环地址**不是认证**：本仓既有路由只用 `isLoopback`（读类接口）；方案 §5 已禁新增审批路由仅凭 loopback。
- `origin/task/sessionId` 是**可见定位符**（会出现在提示、日志、工具结果里），任何本地进程可构造；**不能自签 grant、不能当批准**。
- `reason` 是**模型写的文本**（§2.5），绝不作为授权输入。
- `ctx.on('approval/request')` 是**进程全局**接缝，同用户内无隔离。
- 官方把审计权只交给 `ApprovalService`，答复者只有"返回值"这一条路。

推荐链（**签发 → 保管 → 校验 → 撤销**，全部宿主侧，客户端不可伪造）：

1. **控制凭据（control credential）—— 离线初始化（Codex 修正已并入实现）**
   - 签发：**只由受信任的本机 CLI/安装动作离线初始化**（`dsh-task --approval-key-init`），在**仓库与工作区之外**的用户私有目录原子生成 key 文件（temp+link 语义"只在不存在时创建"，`--approval-key-rotate` 才显式轮换且轮换=撤销全部旧 grant）。
   - 缺 key ⇒ **整条审批能力默认关闭**（`capabilities.approvals.enabled=false`，审批路由 401，委托派活零执行拒绝）。
   - **不存在任何未认证的 HTTP enable/bootstrap/领 token 路由**：enable/清单/详情/决定/撤销全部要求 `X-Dsh-Control`；桥接内部读 key 后只传 **SHA-256**（`sha256:<hex>`），**raw token 不出现在任何 HTTP 响应、MCP 工具输入/结果、会话日志、审计正文或错误正文**（审计只记 `credHash` 前缀）。
   - 传输：审批相关路由经 `X-Dsh-Control` 头（**不放 query**，避免进日志/历史）；错误正文只回凭据类 reason，不回显收到的值。
2. **任务能力（task grant）**
   - 签发：控制凭据校验通过 **且** taskId 存在 **且** origin 与该任务登记来源一致 **且** 用户已声明授权范围（显式条目，无通配）才签发。
   - 结构：`{grantId, taskId, originThreadId, scope, sessionIds, version, issuedAt, expiresAt, nonce, credHash, status}`，**不可变**（改范围=新版本新 grant，旧版立即 revoke），落用户数据目录 JSONL（复用 `harness/fs-lock.mjs`）。
   - 租约：默认 60s（方案 §5）。**只有"通过凭据校验且匹配该 grant/task/session 的调用"能续租**（清单/详情/决定接口）；旧的公开 status 查询、DSH 自己的事件、任意本地 heartbeat **都不经续租路径** ⇒ 不能靠它们让租约永续，也不能因为 MCP/CLI 在轮询就宣称模型一直活跃（等待本身有界，见 §3.3）。
3. **决定时校验（唯一真正产生批准的时刻）**：控制凭据 + grant 存在/未撤销/未过期/版本匹配 + **实时桥接快照**（`req.agent.session.id` + `callId` + 参数指纹 SHA-256）全部匹配 + `req.signal` 未 abort + **审计 append 成功（写失败=不决定，fail closed）** ⇒ 才 `return "allowed-once"`。任何一项失败 → `return next()`（人工仍可处理）或按语义 `rejected`（仅当 grant 明确拒绝）。
4. **撤销**：显式 revoke（grant.status=`revoked`）、grant 过期、任务终态自动失效、控制凭据轮换（删 key → 校验全部失败）。每次决定都重查，不缓存。
5. **边界诚实声明**：同一操作系统用户仍可读取 `control.key` ⇒ 本链挡的是**网页/远程/提示注入/可见 ID 伪造**与**事后重放**（nonce+指纹+单次状态机），**不是**同用户恶意进程的强隔离。方案 §5 已承诺不作不成立的安全承诺 ⇒ 保持。

> 不采用：仅 loopback、仅 origin/task、`dryRun` 探测、提示文字、仓库文件、`reason` 里写"安全"作为授权（全部被 §5 禁止，且本轮证据说明它们都是可伪造输入）。

### 3.5 无重启/不改 preset 的 live canary 可行性

**结论：本轮做不到真正的 live canary，且不伪造。** 理由：

- 新答复者是**宿主侧插件代码**（`dsh-bridge.mjs` 经 `cordis.patch.yml` 以 bundle 装载）；替换包内容**不会热重载**（本仓 README 已证：需重启 profile 才跑新 JS 模块）；client-plugin HMR 只覆盖"客户端插件 + dev watcher"，不适用宿主 bundle。
- 现装 DSH desktop 插件与 Codex 全局安装：**0.1.9**（Codex 于本轮当日重读文件确认；M0 撰写时引用的 0.1.7 为旧记忆，已作废。安装/加载验证仍由 Codex 在审查后统一处理，本轮未装、未重启）。
- 读取已有会话的 `approval/asked` 日志做观察 = 读用户其它会话存储 ⇒ **本轮禁止**。

**替代验证边界（可实施、且不碰运行中的系统）**：
1. **Native harness（M1 主证据）**：在 `.tmp` 内用**只读抽出的真实模块**（`@deepseek-ai/cordis`、`dsh-user-approval`、`dsh-scope`、`dsh-sandbox`、必要时 `dsh-tools`）搭最小宿主，装载**我们的 handler**，真实调用 `ApprovalService.request()`/`approveEscalation()`，断言：prepend 抢先、非关联请求 `next()` 链到达 UI 替身、`never` 在 answerer 之前拒绝、signal 中断 → cancelled、卸载后新请求不再到我们、在途请求 dispose 行为、内部异常 → next 而非 unavailable、单次消费、指纹不符拒绝。方法论与 dsh-memory 已验收的 native 测试一致。
2. **已做的官方侧只读取证**（本文件 §2）+ 未来 M3/M4 的**真实 canary**（需用户授权安装+重启）。
3. **未来真 canary 的加载前提**（写清楚，供 M3/M4 执行）：
   - 用户授权安装更新 bundle + **重启 profile 进程**；
   - 目标会话 `approval/policy` 为 `ask`（**默认值**；`never` 会先于 answerer 拒绝，canary 必然被拒——注意本机当前注入的系统提示即为 never 语句，说明存在 never 会话 [V]）；
   - **不改**全局 preset / `approval/policy` / never（走 `dsh-permission-presets` 之外的手动路径，本方案不调 `setPolicy`）；
   - 委托经用户显式启用（控制凭据在场）；
   - canary 动作 = 授权仓库内**临时目录**的无害读写（要求 `workspace-write` 升级，正触发一次真实 ask），带预期 nonce；
   - 证据 = 官方 `approval/asked`（含预期 toolName/callId）+ `approval/decided{allowed-once}` + 任务完成 + 我方审计，**无人点击**；
   - 不涉及发布、删除用户数据、凭据操作、空闲唤醒（`canWakeIdle:false` 保持）。

### 3.6 对方案的必修建议（6 条）与 M1 文件拆分

**必修**：

1. **参数来源必须改写**（方案 §4.3/§2 目前写"参数来自正式 req/执行日志"）：`ApprovalRequest` **不含参数**。改为：参数只来自 ① 宿主侧 `tools/pre-execute` 快照（`callId→{name,arguments,rootCallId}`，执行前、结构化、native/PTC 同门），② 日志 `tool/call` 按 `asked.callId` 关联的序列化 `arguments`+`turn/step`；**决定接口绝不接受客户端提交的参数副本**；`callId` 缺失或两侧都不匹配 → 不支持委托（`next()`）。
2. **"注册顺序与公开优先级未证实"应删除**，换成已证事实（§2.3）+ M1 native 确认项（真实 profile 中 UI/ACP/我们的相对顺序只作确认，不作假设）。
3. **启用路径具体化**（§4.1 "可信 Codex 调用路径"）：写出控制凭据的一次性签发流程与"不得靠 loopback/ID/提示文字"的机检点；`grantVersion` 随授权范围变更而增，旧版即刻 revoke。
4. **worker 目标能力如实置 false**（§4.2）：M0 未证明 `childId→Agent`；capabilities 里写 `session: supported, worker: unsupported(reason), ptc: params-only`；PTC 的 callId 嵌套绑定列为 M1 native 待证项。
5. **官方 id 口径**（§4.3）：`officialId` 只能事后观测（`asked` 先于 `decide` append），审计字段 `observed|omitted`，**不得因缺官方 id 而阻塞决定，也不得自己写 asked/decided**。
6. **把"UI 委托"写进流程与风险表**（§4/§9）：无人值守依赖 prepend；有人在场时仅当 UI 走到其**内部** delegate 协议路径才会转交（渲染层无已证实按钮）；**已在 UI 等待的请求不可自动接管**；官方无超时 ⇒ 我方租约到期必须 `next()` 交还，不能 hang、不能 throw、不能凭超时批准。

**M1 文件拆分（可实施、无新依赖）**：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `harness/codex-approvals.mjs`（新，纯逻辑） | grant 签发/撤销/租约、`callId` 快照表、指纹计算、单次状态机（`pending→decision-submitted→confirmed` 及 `rejected/cancelled/expired/superseded/decision-unknown`）、幂等键、审计 JSONL（复用 `fs-lock.mjs`）、控制凭据哈希校验 | `openApprovalStore()`, `issueGrant()`, `revokeGrant()`, `snapshotCall()`, `verifyDecisionKey()`, `appendAudit()` |
| `harness/dsh-bridge.mjs`（改，接线） | `ctx.effect` 注册 prepend answerer（谓词+`next()` 兜底）、`tools/pre-execute` 快照钩子、`/api/dsh-bridge/approvals`（list/detail/decide，`X-Dsh-Control` 校验）、任务状态加 `needs-approval`、capabilities | `approvals` capability、`originBinding` 不变 |
| `mcp/dsh-mcp.mjs`（改） | 新工具 `dsh_approvals`（清单/详情/有界等待）、`dsh_approval_decide`（`approve-once`/`reject`，带凭据）；`dsh_task_status` 见 `needs-approval` 不报终态 | **CI 工具数断言必须同步改**（现断言"恰好 6"，计划 §6 已要求同步而非删除） |
| `codex-plugin/.../task.mjs` + `SKILL.md`（改） | `--approvals`/`--approve`/`--reject`；来源显式；needs-approval 后继续**同一** task，不重发派活 | 退出码新增 `needs-approval` 映射 |
| 测试 | `test/codex-approvals.test.mjs`（状态机/幂等/审计/租约/撤销）、`test/approval-native.test.mjs`（抽出真实 cordis+user-approval+sandbox 驱动）、`test/approval-e2e.test.mjs`（真实 HTTP+MCP+CLI 两次审批）、`test/dsh-bridge.test.mjs` 回归 | 保持既有 117 项与包契约 |
| 文档 | `docs/DSH_APPROVAL_DELEGATION.md`（新）+ 本证据文件 + README 简述 | 不改 M0/M1 计划原文 |

---

## 4. 未验证 / 需 M1 native harness 确认（诚实清单）

1. 真实 profile 中 UI、ACP、我们三者相对注册顺序（prepend 是否足够，需要实跑确认）。
2. root 注册 vs `agent.ctx` 注册在 `Context.filter` 下的保留集（推断 root 可达，未实跑）。
3. `resolveAgent` 取回的对象与 `req.agent` 的同一性（更稳妥的判据已改用 `req.agent.session.id`，见 §3.1）。
4. `tool/call` 是否恒早于工具体内 ask（若否，参数须只靠 pre-execute 快照）。
5. PTC 的 callId/rootCallId 与 ask 的对应关系。
6. fiber 卸载后**在途**链条回调的实际行为（数组副本推断 [I]，需实跑）。
7. 同一请求被多个答案者并发到达时的 `dispatch` 实测顺序（prepend 挤压 UI 的真实时序）。
8. 官方 id 从日志观测的匹配在"同 turn 同 toolName 多调用"下的消歧（需 `callId` 必须存在的强制检查）。

## 5. 本轮边界声明

- 只读：官方 asar、方案文件；**未改生产代码、未改 `.codex-plugin`、未动 `approval/preset/never`、未重启客户端/DSH、未发布、未打 tag、未推送**。
- 未读取凭据/登录文件/用户其它会话存储（观察受限，见 §3.5）。
- 新增文件：**仅本文件** `docs/CODEX_DSH_APPROVAL_M0_EVIDENCE.md`；方案文件 `docs/CODEX_DSH_APPROVAL_DELEGATION_PLAN.md` 原样保留未改。
- 工具产物：`E:/07-Workspace_codex/.tmp/dsh-approval-protocol/scan-approval.mjs`（只读扫描器，非运行时依赖）。
- 空闲自动唤醒：仍 **blocked**（`canWakeIdle:false`）；本方案不声称 MCP/收件箱/HTTP 监听能唤醒模型。
