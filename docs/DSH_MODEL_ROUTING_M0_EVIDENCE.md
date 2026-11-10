# DSH 动态模型路由 M0 证据（本插件侧独立复核）

范围：`session-dd9655aa-b99f-4e36-b914-a5035fd094e1`（原 DSH 项目会话）实施，Root 独立验收。
本文件只记录**可复现的真实证据**与**明确缺口**；不冒充远端模型健康、不冒充 Desktop 验收。

复核对象：`D:/Program Files (x86)/DSH/resources/app.asar`（**SDK 0.2.2-rc.1**，只读；本文件 §1–§3 的行号是 **0.2.0-rc.2** 时记录的基线）。
复核方式：本插件独立从 asar 只读提取 `lib/*.js` 文本并按行定位（脚本 `.m0-check.mjs`，一次性），
与 Root 只读笔记 `model-routing-sdk-notes.md` 交叉对照；**下表的行号由本插件自己复核得到**（个别与笔记不同处按本表为准）。

## 0. 宿主版本适配（0.2.2-rc.1）

DSH 于 2026-11-04 升级到 **0.2.2-rc.1**（`dsh-app-boot`/`dsh-agent-loop`/`dsh-subagent`/`dsh-llm` 等同批 0.2.2-rc.1，
`cordis 4.1.0`）。本插件按新宿主更新了**证据与契约测试**，生产接线本身不变：

| 变化 | 0.2.0-rc.2（§1–§3 基线） | 0.2.2-rc.1（当前） | 本插件处理 |
|---|---|---|---|
| 审批状态的来源 | `ApprovalService` 自己维护 policy/turnOpen | 改为 **`ctx.sessionProjections` 投影**：`approvalStateDefinition`（key `approvalState`）由 `sessionProjections.register` 提供，`approvalStateOf(session)` 读 `handle.stateOf(session)` | 生产仍只挂 `approval/request` 瀑布并观察官方 `approval/asked|decided`；`test/approval-native.test.mjs` 改为用**真实 `SessionProjectionRegistry` + `Service.init`** 验证同一契约 |
| 回合/步进边界 | `dsh-agent-loop` 导出 `turnBoundaryProjectionDefinition` | 定义移到 **`dsh-agent`**（`stateVersion: 2`，内部常量，不再直接导出），公开面是 **`ctx.agents.turnBoundaryOf(session)`**（真实投影） | `test/delivery-native.test.mjs` 改用真实 `AgentRegistry` + 投影读取 `turnBoundaryOf(session)`，断言原语义（含 0.2.2 新增 `lastStepStartSeq`） |
| 关键 hook / API | — | `agent/inbox/claimed`、`agent/request-error`、`prepareRequest`、`startActivation`、`isOwnedBy`、`listProviders/listModels/resolveModelInfo`、`defineTool` 等仍存在（行号后移） | 新增 `test/dsh-compat.test.mjs`：只读 asar 校验 `engines.dsh` 覆盖当前宿主 + 上述入口存在，宿主再升级时第一时间失败 |
| 全局默认模型 | `selectModel` → `agentDefaultModel.saveSelection` | 不变（仍**绝不使用**） | `test/dsh-compat.test.mjs` 仅确认该入口存在（用于"知道它存在但不调用"的边界） |


## 1. 目录与能力 API（真实存在，非镜像）

| 事实 | 本插件复核位置 | 对实现的意义 |
|---|---|---|
| `listProviders()` 只列**当前已注册 adapter** 的路由，按注册顺序 | `dsh-llm/lib/index.js:1899` | 候选只能来自运行时已注册配置；不读 settings/凭据 |
| `listModels(provider)` 异步、按 provider 取目录，逐 provider 失败可隔离 | `dsh-llm/lib/index.js:2073` | `createModelCatalog` 的 per-provider try/catch 与失败隔离依据 |
| 无 `getModelsList`（全文 0 处） | — | 不存在的 API 不得使用 |
| `llm/adapters-updated` 拓扑变更通知 | `dsh-llm/lib/index.js:1806, 1883` | 缓存失效信号（有界 TTL + 主动 invalidate） |
| 显式不支持的 effort **直接抛错**，不自动 alias/clamp | `dsh-llm/lib/index.js:2178, 2182` | 跨模型时必须清掉不兼容 `reasoningEffort`，绝不沿用 |
| 失败分类要求按**稳定 code**（禁止解析 message 文本） | `dsh-llm/lib/index.js:127, 150, 253` | 本插件 `classifyFailure` 只认 code/status |

**已配置 ≠ 已列出 ≠ 真可调用**：目录/能力解析成功**不**等于凭据、额度或远端健康已验证；元数据不含质量/速度/价格评分，
`toolUpdate` 是历史投影规则而**不是**"支持工具调用"的布尔。本插件的 `/models`、`capabilities.modelRouting`
与 MCP/CLI 输出都按此措辞如实标注。

## 2. 同 turn/step 的请求恢复点（M2 接线的依据）

| 事实 | 位置 | 对实现的意义 |
|---|---|---|
| `prepareRequest(turn, step, signal)` 在每次 attempt 前重新组装 | `dsh-agent-loop/lib/index.js:1050, 1163` | 每个 attempt 都会过 `agent/request` → 可在下一次 attempt 换 pair |
| `agent/request-error` waterfall 只在**结构化模型失败**时触发 | `dsh-agent-loop/lib/index.js:1124` | 有界切换处理器挂在这里；返回 `{kind:'retry'}` 才同 turn/step 重试 |
| `firstAttempt` 才追加用户输入 | `dsh-agent-loop/lib/index.js:1048, 1061` | retry **不重派 prompt**（我们的切换不产生重复用户消息） |
| 首 attempt 的 `agent/request` 早于 accepted `user/message` 落盘 | `:1050`（prepareRequest）先于 `:1061`（append user/message） | 不能靠事后日志 rpc 绑定首请求 → 必须用 `claimed` |
| `agent/inbox/claimed` 在 claim 时同步发出（真实 agent/message/turn） | `dsh-agent-loop/lib/index.js:106` | 首请求归属的唯一可信入口（`message.source.rpcId` 匹配派活前登记的 requestId） |
| 工具只在**完整 assistant 消息**之后执行 | `:476, :488`（step 工具调度） | 失败 attempt 的部分 tool-call delta **不会执行**；已执行的 nonce 工具不会重跑 |

## 3. 不得使用的旁路（M2 明确回避）

| 事实 | 位置 | 本插件的做法 |
|---|---|---|
| `sessionController.selectModel` 会 `agentDefaultModel.saveSelection(...)` | `dsh-api-session-controller/lib/index.js:720, 736` | **完全不用**；测试断言全局 default 保存次数为 0 |
| 原生 retry 有 `normal` / `always` 两种模式，`always` 在**外层**并用 `settleDownstream(next)` 捕获下游抛错后继续 | `dsh-llm-retry/lib/index.js:51, 119, 153, 164, 169`；`settleDownstream` :31–42 | **当前实现（已是修正后行为）**：托管任务的 `agent/request-error` 以 **prepend** 注册并**拥有终态权**——候选耗尽抛 `MODEL_ROUTE_EXHAUSTED`、其它终态直接 `return undefined`（**不调 next**），因此 always 拿不到继续重试的机会；只有**未托管**请求才 `next()` 交还下游。详见 §5 R1 与 §6 W 前的对照表 |

## 4. 第一版验收反例与修正（Root 独立复验指出，A–F；**历史记录：旧实现的问题与当时修法**）

第一版交付被 Root 独立验收否决，原因**不是**测试计数，而是真实生产行为。逐条修正与对应回归：

| # | 反例（Root 实测） | 修正 | 回归 |
|---|---|---|---|
| A1 | 完整 bridge 任务 done 后，原 backup 的人工下一 turn 仍走 deepseek（request/header 泄漏） | 恢复改为**逐 agent 真实基线**（首请求时从 `next()` 捕获机器本会用的配置），不再用全局 `lastOverride`/`agents.options[0]`；人类改选优先 | `model-route-host.test.mjs`「泄漏条件恢复（逐 agent）」 |
| A2 | 单个旧 A 绑定跨 turn 覆盖人工显式 alternate，并把人工 turn 记给 A | 绑定**只在本任务那一个 turn 内有效**：turn 不符立即失活（`retireBinding('turn-moved-on')`），并尝试订阅官方 turn/end | 「A/B 反例回归：绑定只在本任务 turn 内有效」 |
| A3 | 登记 sessionX 的 task 被真实 sessionY claim 仍绑定 | claim 时核对 **exact live agent + session**（ID 只是关联标识）：`agents.get(id)===agent` 且 claimed/live session 与登记一致，否则拒绝并留 `session-mismatch` 审计 | 「A 反例回归：sessionX 被 sessionY claim → 拒绝」 |
| B | worker 首输入是 `kind:user` 无 rpcId → 一直是 backup；且预分配 ID 错放 `request.childId` | `onClaimed` 增加 **worker 路径**：按预分配 childId == 真实 agent id 唯一匹配；bridge 把 id 放到 **startContinuable 顶层 `spec.childId`**，复用驻留 child 时沿用其 childId | 「B 反例回归：worker 首请求按 childId 绑定」 |
| C1 | 供应商 retry-after=1000ms 实际 2ms 就重试 | `boundedDelay` 有界等待（尊重 signal/取消/卸载），上限 `maxRetryAfterMs` | 同 C 回归（实测 ≥250ms） |
| C2 | 原生 `always` 下单候选预算 max2 仍 6 次请求 + 4 个官方 retry | 耗尽时**抛出结构化终止**（`MODEL_ROUTE_EXHAUSTED`）+ 通知宿主 abort 本任务 signal；不再 `return next()` 把控制交回 always | 「C 反例回归：候选耗尽 → 真终止」 |
| D1 | 官方 `reasoning.efforts` 是 `[{id,name}]`，旧实现只滤 string → 空数组，误拒支持 high 的模型 | `capabilityOf` 同时接受对象/字符串并取 `id`；`defaultEffort` 也兼容对象 | 「E 反例回归」第 1 项（含 `cap.efforts==['low','high']` 断言） |
| D2 | `resolveModelInfo` 明确抛 `UNKNOWN_MODEL` 仍被当"未知能力"首选 → 不可恢复的准备期失败 | 已知不可解析码（UNKNOWN_MODEL/INVALID_CONFIG/NO_ADAPTER/…）**排除候选**；只有真正的"未知"才标 `capability-unknown` | 「E 反例回归」第 2 项（全部不可用 → `capability-unresolvable`） |
| D3 | 继承 high 切到不支持 reasoning 的模型 → `UNSUPPORTED_REASONING_EFFORT`，stream 0 | 每次切换按**实际目标能力**处理 `reasoningEffort`（不支持则用其 `defaultEffort`，能力未知则不带）与 `maxTokens`（收敛到目标上限）；不删图片/不截历史/不重放工具 | 「D 反例回归：按目标能力处理 effort/maxTokens」 |
| E1 | 自定义 provider 下的 DeepSeek 模型未获偏好 | 偏好同时看 provider 与**模型 id/name** | 「E 反例回归」第 3 项 |
| E2 | exact 不产生 alternatives → 显式 `modelFallback:true` 无池可用 | exact 也生成备选池（`allowFallback:false` 时空池=固定）；`inherit+allowFallback` 预生成池、首 attempt 用机器配置 | 「E 反例回归」第 4 项 |
| E3 | 首 provider 目录挂死 → 整次 snapshot 不返回 | 目录发现**逐 provider 有界**（`PROVIDER_DISCOVERY_TIMEOUT_MS`，默认 3s），失败隔离 | 「E 反例回归」第 5 项（实测 <2s 且有其它候选） |
| F1 | 扁平 `sessionId+model` 202，但 `target.kind=session+model` 400 `invalid-target` | 决策层允许 session 目标带 model（两种书写一致） | 新回归 + 更新旧断言 `session-target.test.mjs`（cwd/lane/commit 仍拒绝） |
| F2 | 重启后同 origin/task 查询 route/routeAudit 消失；旧"重启测试"只断言空数组也算 array | route/routePolicy 在 **bind 时即落盘**并随每次 persist 更新；恢复分支对**同 origin** 返回 `route`/`routeAudit`（执行状态仍如实 unknown），错 origin 404 | 「F 反例回归」：非空 + 每条 taskId/origin 匹配 + 错 origin 拒绝 |

## 5. 第二轮验收反例与修正（Root 第二轮独立复验指出；**历史记录：旧实现的问题与当时修法**）

第一轮修正后 Root 复验：完整回归 203/203、policy 5/5、HTTP/恢复 6/6 通过，第一版 10 个原生反例 8 项翻转；仍剩 4 类真实缺陷：

| # | 反例（Root 实测） | 修正 | 回归 |
|---|---|---|---|
| R1 | 原生 `always` 下单候选预算仍 6 请求 / 4 retry（fixture 取消才停） | 根因：`dsh-llm-retry` 的 always 在**外层**并用 `settleDownstream` 吞掉下游抛错。修正：`agent/request-error` 改 **prepend**；托管任务**拥有终态权**——耗尽抛 `MODEL_ROUTE_EXHAUSTED`、其它终态直接 `return undefined` **不调 next**，非托管才 `next()` | 「第二轮1」：断言 `prepend:true`、托管终态 `nextCalled===0` |
| R2 | 目录/能力 `await` 期间卸载，返回后仍写 plan/审计、仍把 backup 改成 DeepSeek | **closed + generation 门闩**：`planRoute` 每 await 后校验（取消则 `cancelled:true`、零写零计数）；`onRequest` 在 `next()`、选择 seq、`resolveInfo` 三处 await 后复核 `isLive()/binding.active`，不满足即返回机器原配置且不写审计；卸载即释放等待 | 「第二轮2/3e」：await 中卸载 → plan 不落盘、请求返回 backup、无 `first-request` 审计 |
| R3 | 连续托管 A/B 后 B 把 A 的覆盖当成新用户基线，人工 turn3 仍 DeepSeek | 意图按 **agent** 记录且**跨连续托管任务保留**：仅当机器提出的是"我们上一次的覆盖"时沿用旧基线，否则才更新 | 「第二轮3」①：A→B→人工 turn3 恢复最初 `backup/high` |
| R4 | 用户真实 `model/selection` 明确重选**同值**仍被恢复成 backup | 用**官方选择事件/seq** 判定：会话里最后一条 `model/selection` 的 seq 晚于我们记录时 → `respect-human-selection`，绝不恢复（不再只比字符串） | 「第二轮3」②：同值重选保持 DeepSeek 且有该审计 |
| R5 | 恢复回"原无 reasoning 的人工模型"时残留我们带的 `low` → `UNSUPPORTED_REASONING_EFFORT` | 基线保存**完整配置快照**（含"原本没有 effort/maxTokens"）：基线没有的字段一律删除 | 「第二轮3」③：恢复后 `reasoningEffort===undefined` |
| R6 | 真实 registry 中属于**另一 parent** 的 child 因同 childId 仍被接管 | worker 登记 `expectedOwner`（bridge 传真实 owner id）；claim 时解析成**当前 live owner 对象**并调官方 `agents.isOwnedBy(childId, owner)`；拿不到/不在 registry/不属于它 → fail-closed | 「B/D」：无 owner、错 owner 都不接管并留审计；正确 owner 才绑定；registry epoch 变化后旧绑定失效 |
| R7 | `persistTask` 在 bind 前调用，打印 `association update failed: task has no association record` | 持久化移到 `bindAssociation` **成功之后**（route/routePolicy 已由 `bind()` 携带，行为不变） | 「F 反例回归」仍通过且不再出现该日志错误（不隐藏日志、不动旧锁） |

## 6. 完整 worker 复用路径修正（Root 用真实 SubagentRuntime/SpawnInProcessProvider 发现；**历史记录：旧实现的问题与当时修法**）

> **warm 证据边界（2026-10-17 收尾澄清）**：官方参考脚本证明 **warm（同一 live child 直接复用）** 是官方支持的通道；
> 但本插件的 **bridge 业务入口** 同一 lane 串行（同桶有在途任务会明确 busy 拒绝），所以实际可达的时序是
> **"连续任务 + 自然释放后 cold 恢复"**——参见 `test/manual/model-routing-worker-native.mjs` 与 §7 的诚实说明。
> 下面 W1 中"warm 直接复用"描述的是官方 `subagents.prompt` 的语义（官方参考证据），**不是** bridge 业务入口已证 warm。

第一、二轮修正后 Root 用 **44 个与本机 ASAR 字节一致的官方包** + 真实 SubagentRuntime / SpawnInProcessProvider /
JsonlSessionPersistence / SessionQueryEngine 复现：第一条 worker 成功，**第二条**却调用不存在的
`subagents.followup` → 降级 one-shot 新建 child（丢 nonce 历史、实际跑 backup 却回选 DeepSeek、attempts=0 却 done）。

| # | 反例 | 修正 | 回归 |
|---|---|---|---|
| W1 | 继续第二个任务时调用 `subagents.followup`（本机官方包里**不存在**） | 改用官方 **`subagents.prompt({requestId, parentSessionId, childSessionId, mode:'continuable', delivery:'queue', content}, signal)`**：warm 直接复用 live child，cold 由官方 `coldResume` 自然恢复；`requestId` = 本次 taskId（首请求归属靠它）；父 = 真实 live owner **Agent id**（官方内部 `agents.get(parentSessionId)` 查找） | 「真实官方 worker」回归：创建→warm→cold 全程同一 durable child |
| W2 | 失败即 one-shot 新建 child 冒充恢复，并报 done/chosen | **删除 one-shot 兜底**：继续失败 → 任务如实 `error`（`worker-continuation-degraded`），不清 `childId`、不新建 child、不重派 | 同回归 + 兜底分支改错误语义 |
| W3 | 未保存 durable child 的 `childSessionId` | `startChildWith` 记录 `bucket.childSessionId`（= `started.childId`；warm/cold 同一 id） | 同回归 |
| W4 | worker 带 rpcId 的 warm/cold claim 跳过 owner 核验 | `onClaimed` 对所有 worker plan（含带 rpcId）核验 `expectedOwner` + 当前 live owner 对象 + 官方 `agents.isOwnedBy`；owner 不在 registry/不匹配 → fail-closed | 「B/D」回归扩展（每 epoch 重新核验） |

**本插件侧实测**（Root 探针的同款完整官方服务，`native-workers-production.mjs` 的 scratch 副本）：
第一条 `done`；第二条 **`SAME_DURABLE_WORKER_SUCCESS`**、请求为 `dsh-bridge-child-*/turn 2/priorNoncePresent=true`、
nonce 仍 **1**、`fallback` 字段消失、routeAudit 含 `plan → first-request-bound → first-request → finish`（此前只有 plan→finish、attempts=0）。

## 7. 故障收口与长任务恢复预算修正（Root 第 55 轮独立证据；**历史记录：旧实现的问题与当时修法**）

| # | 反例（Root 实测） | 修正 | 回归 |
|---|---|---|---|
| F1 | 会话任务三候选全 AUTH：原生已出现 `MODEL_ROUTE_EXHAUSTED` + 同 turn 的 `turn/end reason=error`，但 HTTP 任务仍 `accepted`、审计只有 `stop` 无 `finish` | 根因：`onExhausted` **abort 了自己的观察者/prompt 信号**，丢掉原生结束证据。修正：**不 abort 观察者**；把"路由已给本任务终态"作为**可信本任务终止事实**（`onTerminal`），先给原生日志一次机会（`turn/end` 非 completed → 按原生原因收口），否则 250ms 内用该事实收口 `status=error` + 稳定 `reason=model-route-exhausted` + `routeStopReason` + `finish` 审计；不 cancel 用户 Agent、不清别人 inbox、不碰其他 queue、不重派 | 「C 收口」host 断言（耗尽/禁 fallback 都通知 `onTerminal`、不 abort 观察者）+ Root `probe-exhaustion-status`（→ `status=error, reason=model-route-exhausted, routeStopReason=candidate-limit`，审计含 `finish`） |
| F2 | 评审第 4 阶段 expert primary + `modelFallback:false` 真实 AUTH 失败一次，网关却 **done / result="(无输出)"** | 根因：`subagent/end` 一到就 done。修正：按官方 `SubagentResult.stopReason` 收口——`error/aborted/refusal/max-tokens/interrupted/failed/cancelled` → **error**（带 `subagent-turn-failed`/`model-route-exhausted` 与真实 stopReason，部分文本只作 `partialResult`，绝不当成功）；成功结束文本为空仍 done（**不凭文本空判失败**） | 「失败收口」自动回归（失败 stopReason → error、成功且空文本 → done、评审同样收口）+ Root `native-reviewer-final-contracts`（`reviewerContractsAccepted=true`） |
| F3 | 默认 `totalTimeoutMs=300000` 从**建任务**算：健康执行 5 分钟后首次 AUTH 直接 `total-time-limit`，备选闲置；`perPairTimeoutMs` 只声明不参与决策 | 预算改为**恢复 episode**：从第一次故障开始计时（健康运行/工具等待不计入）；恢复成功（turn/step 前进且无失败）关闭 episode，下次故障重新获得完整恢复权；`perPairTimeoutMs` 真实参与决策（该 pair 在 episode 内超时 → 不再重试它，改切换）；retry-after 等待走真实时钟自然计入，**不因每次 retry 重置**；候选/次数/总恢复时长上限保留 | 「恢复预算」M1 假时钟回归（长健康→首次故障可切、单 pair 超时→切换、retry-after 计入总预算、成功后重置）+ Root `probe-recovery-budget-age`（`firstFailureCanSwitch=true`、`timeLimitCausedSwitch=true`） |

## 8. 本插件侧结论：哪些已证、哪些仍是缺口

**已证（本插件自己的可复现测试）**

1. 目录：provider 失败隔离、有界缓存/失效、失败不永久缓存、pair 身份、**逐 provider 有界发现**（E3）。
2. 选择：DeepSeek 偏好（provider+model，E1）、对象形 efforts（D1）、已知不可解析排除（D2）、
   模态/上下文/effort 不兼容拒绝、精确/歧义拒绝、exact 备选池（E2）、inherit 语义。
3. 分类与有界：稳定 code 分类、可切/先重试后切/绝不切、HTTP404 只表示路由不可用、未知 code 不切、
   每 pair 次数/候选上限/不重复/冷却/total 时限、**retry-after 有界等待**（C1）、**耗尽真终止**（C2）。
4. 宿主归属与身份（ctx 替身，语义与官方 hook 签名一致）：`agent/inbox/claimed` 首请求认领、
   **exact live agent + session + turn 三重核对**（A2/A3）、worker childId 绑定（B）、
   逐 agent 条件恢复（A1）、按目标能力调 effort/maxTokens（D3）、卸载后绑定失效。
5. HTTP/MCP/CLI：`/models`、`capabilities.modelRouting`、auto 回显、精确/歧义零投递拒绝、
   **双入口（扁平/显式 target）一致**（F1）、**重启后按 origin/task 取回非空 route/routeAudit 且错 origin 404**（F2）、
   旧网关新语义零派活、评审入口接入同一任务级机制 + 四入口同契约（第 54 轮）。
6. 失败收口与恢复预算（第 55 轮）：耗尽/禁 fallback 的会话任务按**可信本任务终止事实**收口
   `error + model-route-exhausted + routeStopReason + finish`（不 abort 观察者、不 cancel Agent、不碰其他 queue）；
   worker/评审按官方 `stopReason` 判失败（失败绝不 done、也不凭空文本判失败）；
   恢复预算按 **episode** 计（健康时长不计入、perPair 真实生效、retry-after 计入、成功后重置）。

**仍是缺口（如实声明，不假造支持）**

1. **worker 继续通道的 warm 分支**：官方参考脚本已证 warm（同一 live child 直接复用）可行，但本插件的 bridge
   业务入口同 lane 串行（同桶在途任务会 busy 拒绝），实际可达的是**连续任务 + 自然释放后 cold 恢复**；
   仓库里因此不提供自动 warm 回归。Root 的独立证据覆盖"worker 新建 + 两次自然 cold 恢复"
   （同 durable child / 3 live epochs / turn 1–3 / 每任务模型策略 / 真 tool-result / nonce 1 / wrong-parent 拒绝）。
2. **worker `spec.childId` 与 owner 的最终判定**归 Root 独立证据；`capabilities.modelRouting.workerFirstRequestProven` /
   `workerContinuationProven` 在本插件侧保持 **false**（不自我认证）。
3. 跨回合人工 turn 的 request/header 泄漏：本插件用逐 agent 基线 + 官方 `model/selection` seq 处理，
   端到端由 Root 夹具对照（含"同值人工重选"与"连续托管"两个反向案例）。
4. `prepareCall` 期竞态（预检后目录再变：预检排除已证不可用候选 D2，但预检后目录变化无通用恢复 hook）
   与 persisted child 的冷恢复通道如实不接管/不重派，不冒充恢复。
5. 模态/上下文按实际请求的判定：仅在调用方给出 `needs` 时过滤；运行中切换不从消息体推导图片/历史长度，
   "目标模型上下文更小"的极端情形尚无端到端证明（不删图片/不截历史是硬约束，宁可失败也不降级凑兼容）。

## 9. 复现方式

```bash
cd E:/11-Github/dsh-codex-collab
node --test test/*.test.mjs                   # 全部自动回归（当前 213，含 M1/M2/HTTP/MCP/CLI/入口/收口/预算与本插件侧反例）
node test/model-routing.test.mjs             # M1 策略矩阵（含 E 反例 5 项）
node test/model-route-host.test.mjs          # M2 hook 语义/归属/身份（含 A/B/C/D 反例 6 项）
node test/model-routing-integration.test.mjs # 真实 HTTP/MCP/CLI 接线（含 F 反例）
node test/model-routing-sdk-contracts.mjs    # 本文件第 1–3 节行号复核（只读 asar）
```

**手工入口（不计入自动回归计数）**：`test/manual/model-routing-worker-native.mjs`（连续任务 + 两次自然释放 cold 恢复）
与 `test/manual/model-routing-review-native.mjs`（评审默认路由 + 同 turn/step 故障恢复 + nonce 恰一次 + 第二条评审 cold）
都用 Root 的 `runtime-fixture.mjs`（真实官方组合夹具，公共仓库无法把它当可移植回归）：

```bash
DSH_ROUTING_NATIVE_FIXTURE=<...>/model-routing-native-review/runtime-fixture.mjs node test/manual/model-routing-worker-native.mjs
DSH_ROUTING_NATIVE_FIXTURE=<...>/model-routing-native-review/runtime-fixture.mjs node test/manual/model-routing-review-native.mjs
```

未配置该变量时以 exit 2 明确报"未运行"（不是 pass）；配置了但文件缺失/加载失败则以非零失败。

`test/model-routing-sdk-contracts.mjs` 是**只读**脚本：不注册插件、不请求模型、不读凭据，只按上文行号打印命中项；
无 asar 的机器会打印 MISSING 而不是假装通过。
