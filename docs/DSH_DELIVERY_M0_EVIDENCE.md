# DSH 投递控制（queue / steer）M0 官方契约证据

状态：D0 完成。证据来自本机官方 `app.asar` **只读**提取（`D:/Program Files (x86)/DSH/resources/app.asar`），
由 `test/delivery-native.test.mjs` 用真实组件/真实源码契约复现（3/3 通过）。SDK 不进运行时依赖，只写临时目录、测后删除；
无 asar 的环境整体 skip 并显示原因——**不把 native/mock 冒充真实 Desktop 验收**。

基线：`delivery-baseline-EK14CG`（20 文件、SHA256 逐字节核对一致、原 159 测试通过、HEAD `383528c`）。

## 1. 投递入口：`sessionController.prompt(request)`

`@deepseek-ai/dsh-api-session-controller/lib/index.js:850–899`（真实源码，测试逐条断言）

| 事实 | 证据 |
|---|---|
| 请求身份写进 user 消息：`source = { kind: 'user', rpcId: request.requestId }` | `:856–860` |
| **顺序重复去重（有界）**：`if (hasPromptRequest(agent, request.requestId)) return { accepted: true }` —— 同 requestId 已在内存队列**或整份会话日志**里可见时，本次调用不再落一次 | `:855` |
| 去重窗口 = 内存队列（next-turn/next-step）**加整个会话日志**（`agent.session.snapshotEvents()` 里任何 `user/message.source.rpcId` 匹配即算已有） | `:1063–1074` |
| 模式分派：`if (request.mode === 'steer') agent.steer(message); else agent.followup(message);` | `:882–883` |
| **admission 是异步的**（附件/模型校验/`fileUploads.bindPrompt` 都在写入之前 `await`）→ **没有原子的 expectedTurn 条件** | `:862–898` |
| 返回值 `{ accepted: true }` 只表示"已接收"，**不是已执行**、也不是已插入 | `:896` |

结论（首次验收修正 G，措辞收窄到**源码可证**的范围）：这个检查发生在 **async admission 之前**，因此它只证明"**在 inbox/日志里已经可见之后的顺序重复投递**会被去重"；
它**不能**证明并发原子幂等，也**不能**证明"任意时刻重试都安全"（两个并发请求可能都通过检查）。所以我们仍然**不主动重发**：拿不准时按 R1 语义报 `unknown + resend:false`。
但**接收 ≠ 执行**这一点不变，且**没有原子父回合校验**。

## 2. 原生队列：`agent-loop` 的 durable Inbox

`@deepseek-ai/dsh-agent-loop/lib/index.js`（真实源码契约由测试断言）

| 事实 | 证据 |
|---|---|
| `followup(input)` → `send(input, 'next-turn', true)` | `:806–808` |
| `steer(input)` → `send(input, 'next-step', true)` | `:809–811` |
| `inject(input)` → `send(input, 'next-step', false)`（不唤醒） | `:812–814` |
| 入队是**尾插 = FIFO**：`this.inbox.splice(resolvedTarget, Infinity, 0, [message])` | `:800–805` |
| **真实竞态**：`const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted; const resolvedTarget = wakingAfterAbort ? 'next-turn' : target;` —— 回合已 abort 时**steer 会被官方改道成 next-turn** | `:800–803` |
| `claim(target, turn)`：`claimed = mutate('next-step', 0, nextStep.length, …)`（**全部** next-step）；仅当 `target === 'next-turn'` 时再 `mutate('next-turn', 0, 1, …)`（**恰好一条** next-turn） | `:103–111` |
| 回合结束条件：`if (turnEnds && this.inbox.nextStep.length === 0) break;`（steer 在**下一个步进边界**被消费；有 next-step 就不结束回合） | `:998–1006` |
| `clear()` = `splice('next-step',0,len)` + `splice('next-turn',0,len)`（**会清空整个队列**） | `:92–96` |
| `cancel(cause,{keepInbox})` 默认 `inbox.clear()` → 取消回合会连带清掉排队输入 | `:815–821` |

**durable**：pending 列表由投影 `inbox` 从会话事件 `agent/inbox/spliced` 物化（`splice()` → `session.append('agent/inbox/spliced', {target,start,removedCount,inserted,outcome})`，`:159–205`），
投影在校验失败时**抛错**（`invalid persisted inbox splice`），并对跨列表重复的 `message.id` 抛 `already pending`（`:26–56`）。
→ 队列是**会话持久状态**：网关重启不丢队列，官方自己保证顺序；`removedCount` 是**事件字段**（记录"这次 splice 移除了几条"），
它描述的是**官方自己写事件时**的语义，**不等于**我们可以伪写会话日志去做"撤队"——我们不向会话日志写任何 inbox 事件（首次验收修正 G）。

**导出的边界投影**（测试用真实组件跑）：`turnBoundaryProjectionDefinition`（`key:'turnBoundary'`, `:1353–1398`）物化 `openTurnStartSeq / lastStepStartSeq / lastStepBoundary / lastTurn`
—— 这就是"父回合是否仍开放"与"步进边界"的官方判据，队列消费时机依赖它。

## 3. 设计结论（对实现的硬约束）

1. **不另造持久队列框架**：queue 直接用原生 `mode != 'steer'`（`followup`）→ 官方一次 claim 一条 next-turn 的 FIFO；steer 用原生 `steer`（next-step）。
2. **一次 turn 只有一个执行 owner**：因为 `claim` 一次只取一条 next-turn，排队任务各自独立回合；`steer` 进 next-step、与父任务**同 turn**，因此**回执绝不能当审批/结果 owner**。
3. **接收 ≠ 执行**：queue 任务的 `accepted` 只证明官方接收；必须靠自身 `rpcId` 在日志里的 `user/message` + 自己那个 `turn/end` 结算；不得用"最近助手文本"或全会话 idle 判完成。
4. **父回合竞态必须如实报告**：校验通过后官方仍可能（a）把 steer 改道 next-turn（`wakingAfterAbort`）或（b）父回合刚好结束而落到另一 turn。此时**保留真实 receipt + `observedTurn`，明示未确认/偏离**，不静默改模式、不 cancel 用户回合、不重发。
5. **不能用 session cancel 清队列**：`clear()`/`cancel()` 会清掉整队列；`agent/inbox/spliced` 的 `removedCount` 只是官方事件字段，
我们无法从 SDK 调用点安全证明"逐项撤回"，因此对无法证明安全的取消组合（排队项/回执/同会话多任务）**明确拒绝**。
6. **去重是有界的**：官方按 rpcId 去重（含已消费历史），但检查在 async admission 之前 → 只保证"日志/队列里可见之后的顺序重复"；
我们**不主动重发**，拿不准时报 `unknown + resend:false`。
7. **steer 需要显式父任务**：官方只按 `mode` 分派，不校验父；父/回合校验只能由我们在**投递前**做（同 origin/profile/session + 父回合开放），且必须接受"校验后仍可能偏离"的事实。

## 4. 复现方式

```bash
node test/delivery-native.test.mjs     # 3/3：真实 turnBoundary 投影 + 真实源码契约（steer/followup/claim/send/clear/dedupe/admission）
```

未证明/不声称：真实 Desktop 端到端（queue 在忙时被接受、steer 在同 turn 被模型消费）由 Root 用独立临时 profile 验收；
本文件与 native 测试只证明**官方契约**，不冒充真机结果。
