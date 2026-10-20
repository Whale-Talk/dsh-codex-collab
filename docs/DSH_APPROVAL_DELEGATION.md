# Codex 单次审批委托：架构与使用（独立验收修正版）

状态：已实现并自测（144/144）。方案见 `CODEX_DSH_APPROVAL_DELEGATION_PLAN.md`，官方接口取证见 `CODEX_DSH_APPROVAL_M0_EVIDENCE.md`，
本轮针对 root 独立探测发现的问题（跨会话参数替换 / hash-as-bearer / 同 callId 两次 ask / 归属与接口一致性 / 生命周期 / 确认与恢复）逐项修正。
基线 `383528c`；本轮**未**安装、未重启、未发布、未改动全局权限/preset/never。

## 1. 一句话

在 DSH 官方 `approval/request` waterfall 上 prepend 注册一个**严格谓词**答复者：只有"该任务被显式委托 + 该调用能被宿主侧证据完整证明 + 官方 ask 身份唯一"的请求才由 Codex 单次决定（`approve-once`）；其余一律 `next()` 交还人工链。**绝不吞链、绝不凭超时放行、绝不写 asked/decided。**

## 2. 组成

| 文件 | 职责 |
|---|---|
| `harness/codex-approvals.mjs` | 控制凭据（离线初始化、raw key 认证、域分离摘要）、grant（身份/范围/版本/期限/租约/撤销）、**不可变执行快照**、动作指纹、官方 ask 身份台账与唯一认领、单次状态机、幂等、严格失败语义、恢复视图 |
| `harness/dsh-bridge.mjs` | 三条宿主接线（`tools/pre-execute` 快照、prepend 答复者、官方 asked/decided 观测）+ 鉴权路由 + 委托派活时序 + `needs-approval` 非终态 |
| `mcp/dsh-mcp.mjs` | `dsh_approvals`、`dsh_approval_decide`、`dsh_task{delegate}`（带认证头）、`dsh_task_status{wait}` |
| `codex-plugin/.../scripts/task.mjs` | CLI：key 初始化、`--delegate`、`--approvals/--approval-show/--approve/--reject/--revoke-grant/--renew-grant`、`--status-wait`（退出码 9=needs-approval） |

## 3. 认证与授权

- **传输**：`X-Dsh-Control` = **私有 raw key**（离线生成的 64-hex）；服务端与本机 key 文件等值比较（timingSafeEqual）。key 文件格式不合规一律按"无 key"处理，绝不把任意内容当 header 发出。
- **持久**：grant/audit 只存**域分离单向摘要** `digest:sha256('dsh-approval-grant-digest:'+key)`——**它不能用于登录**（旧版把 `sha256(key)` 同时当 header 与 grant 字段，等于 bearer 落盘，已改）。
- **缺 key = 能力关闭**：`capabilities.approvals.enabled=false`，审批路由 401，委托派活零执行。
- raw key 不进：HTTP 响应、MCP 工具输入/结果、会话日志、审计、错误正文、仓库。
- **没有任何未认证的 enable/bootstrap/领 token 路由**；`origin/task/session/callId` 只是**定位符**，永远不构成授权。

## 4. 一次无人值守审批

```bash
# 0) 只做一次：离线初始化（仓库外私有目录；raw key 不回显）
dsh-task --approval-key-init          # 轮换 --approval-key-rotate（= 撤销全部旧 grant）

# 1) 派活时显式开启委托（grant 与 task+origin 绑定**先于** prompt；失败=零派活）
dsh-task --in "<指令>" --session <会话id> --origin <当前对话id> --delegate \
  [--delegate-ttl 900] [--delegate-lease 60] [--authorization "本次授权范围说明"]

# 2) 任务等审批时以退出码 9 及时返回（非终态）→ 取真实动作
dsh-task --approvals --origin <id> --task <taskId> [--grant <grantId>] [--wait-approval 30]

# 3) 逐条单次决定（approvalKey/grantId/fingerprint 都来自上一步；多余字段/参数副本一律拒绝）
dsh-task --approve <approvalKey> --origin <id> --task <taskId> --grant <grantId> --fingerprint <fp>
dsh-task --reject  <approvalKey> --origin <id> --task <taskId> --grant <grantId> --fingerprint <fp>

# 4) 决定后继续收结果（等待期间做认证续租）
dsh-task --status <taskId> --origin <id> [--grant <grantId>] --status-wait

# 撤销 / 在原授权窗口内显式续期
dsh-task --revoke-grant <grantId> --origin <id> --task <taskId>
dsh-task --renew-grant  <grantId> --origin <id> --task <taskId> [--extend 3600]
```

MCP 等价：`dsh_task{delegate:true, authorization}` / `dsh_approvals{originThreadId,taskId,…}` /
`dsh_approval_decide{originThreadId,taskId,approvalKey,grantId,fingerprint,decision}` /
`dsh_task_status{taskId,originThreadId,grantId,wait:true}`。

**CLI 的两条等待路径是同一条**（第四轮修正）：`--in` 的**初次默认等待**与 `--status <id> --status-wait` 共用
`awaitTerminal()` —— 显式来源时每个 status 都带 `originThreadId` 且**逐次**核对回显（缺失/错源 → 退出码 8，不透 result、不重发）、
按响应里的 grant 字段做自适应认证续租、`needs-approval` 立即退出 9、`done/error/cancelled/unknown` 语义不变、无委托任务不续租。
`--delegate` 的派活 POST 也带控制凭据头（缺 key 在预检阶段零派活拒绝）。

## 5. 严格绑定（本轮修正的核心）

1. **参数只来自宿主**：`tools/pre-execute` 快照按 `(sessionId, callId)` 存**深拷贝冻结**的 `args/cwd/rootCallId/parent`；客户端不得代传参数（多余字段直接 400）。
2. **完整执行身份**（第二轮修正）：身份 = `sessionId + callId + rootCallId + parent + toolName + cwd + argsSha256 + turn + step`，**九项全参与** `executionId` 与指纹。任何一项变化 → 旧审批被拒（`approval-context-changed`），包括：
   - `root-only`（换 rootCallId）、`tool-only`（换工具名）、`parent-only`（父执行 token 变）；
   - **`step-only`**：仅日志里新增同 callId 的 `tool/call`（step 变、无新 pre-execute）——所以决定时必须**实时重读日志**取当前 turn/step 再比对。
   决策路径只比 coarse `snapshotId` 是不够的（第一版就是这样被 root 复现放行的）。
3. **未知即 unsupported，绝不假装完整**：身份任一必需项拿不到（无 cwd 来源、工具名空、拿不到当前 turn/step、父身份存在但不可稳定表达、`parentKey` 与 `parent` 不一致）→ answerer 直接 `next()`（走人工、零 pending）；决定路径返回 `execution-identity-unknown` 而不是放行。
4. **官方真实 shape（已核对本机官方源码，不是 fixture 杜撰）**：

   | 字段 | 官方来源 | 证据 |
   |---|---|---|
   | `callId` / `rootCallId` / `name` / `arguments` / `token` / `agent` / `parent` | `tools/pre-execute` 收到的 execution 对象 | `dsh-tools/lib/index.js:3143-3168`（`createExecution`） |
   | `rootCallId` 归一（顶层 = callId） | 同上 | `dsh-tools/lib/index.js:3135` |
   | **`parent` = 父执行的 token** | 嵌套/PTC 派发 | `dsh-tools/lib/ptc.js:439`、`dsh-tools/lib/index.js:1306` |
   | **`cwd` 不在 exec 上**，只能取 `exec.agent.session.header.cwd` | 同一取值路径 | `dsh-tools/lib/index.js:1423`；`dsh-session/lib/index.js:1044-1046`（必须是非空绝对路径字符串） |
   | 一个 execution 只会 pre-execute 一次 | SDK invariant | `dsh-tools/lib/types/invariant.js:88-91` |

5. **turn/step 必须可证**：来自同一 callId 的 `tool/call` 且都是整数；缺一即 `next()`（**未知不得作为可批准默认值**）。turn 还必须等于该任务自己绑定的 turn（R1 requestId→rpcId→own turn）。
6. **官方 ask 身份唯一认领**：观测 `approval/asked` 建立台账；答复者必须恰好命中 1 个未认领项，否则 `next()`（**歧义不猜、绝不按 callId 合并**——同一次调用合法发起两次 `request()` 时各有独立 pending 与独立决定）。
7. **决定七重核对**：origin/task/grant/版本 + 凭据摘要 + 未撤销/未过 TTL/租约未过 + **完整执行身份（含当前日志 turn/step）仍等于 pending 的冻结身份** + 指纹一致；**审计 intent 写成功才放行**。
8. **路径**：`…:ptc:<n>` 嵌套、`rootCallId≠callId`、以及存在父执行（`parent` 非空）一律 `next()`（PTC 能力如实报 false）。

## 6. 生命周期

- 答复者按**有效租约/绝对 TTL 与 `req.signal`** 保持（不再有 25s 硬上限；25s 只是单次 HTTP/MCP 调用的有界等待）。认证续租（清单/详情/决定/`renew`）会延长租约；`renewGrant` 在**原授权窗口内**延长绝对 TTL（封顶 8h）。
- **观察窗口按有效认证委托**（第二轮修正）：只要存在"未撤销、未过绝对 TTL、凭据摘要匹配、严格属于该 task/origin/session"的 grant，sweep **不按 quiet/总预算**收口任务——包括**还没有 ask 的长模型阶段**（默认 1h 总预算不该把 8h 授权的委托收成 unknown/superseded）。上界 = grant 绝对到期 + 宽限，且硬性不超过"授权窗口上限 + 宽限"（仍是有界的，不是无限等）。
- **失联/撤销/到期安全退出**：本机 key 消失 → 摘要取不到 → 立即回到旧预算；撤销/到期 → 同样回到旧预算并有界收口（`unknown` + `resend:false`，pending 交还人工）。**未委托任务语义完全不变。**
- **`needs-approval` 是在途状态**：它计入同会话忙锁——同一会话的第一个任务在等待审批时，第二次派活必须在**发出 prompt 之前**被拒（`session-busy`，零 prompt、不签发新 grant），第一任务的 record/观察/结果不受影响。
- **交还 `next()` 之前先关闭可答状态**（`superseded`/`context-changed`/`expired`），交还之后迟到的批准一律拒绝。
- 撤销/过期/卸载/收口都会安全关闭在途 pending；并发多审批时任务保持 `needs-approval`，最后一条解决才回 `running`。

## 7. 确认与恢复

- `submitted ≠ confirmed`：只有观测到官方 `approval/decided` 才算确认，且**由官方 outcome 决定**：`allowed-once → confirmed`；`cancelled/rejected → 对应终态`（**绝不算批准**，取消可赢过晚到的 allowed-once）；其它 → `decision-unknown`。**reject 的终态是 `rejected`**，提示语不再引导去等只对批准有意义的 `confirmed`。
- handler 只返回 SDK（不在 handler 里等自己的 decided，也不把自己返回当采纳）。
- 重启后：`submitted` 未确认 → `decision-unknown / live:false`；无决定记录 → `unanswerable / live:false`（不静默消失、不可再次批准）。
- **运行中绝不重复上报**（第三轮修正）：`unanswerable` 只列**本进程内存里没有对应 pending** 的记录——同一 `approvalKey` 不会既出现在 `approvals`（`live:true`）又出现在 `unanswerable`（真实 profile 曾把活跃 pending 当成"重启后无 callback"）。恢复能力本身不变。
- **权限记录（grants.jsonl）任何坏行/截断 → 安全失败**（`grant-log-corrupt`，列表为空、撤销/续期拒绝），不沿用旧有效授权；审计展示可另论。

## 7.1 客户端定位字段（第三轮修正 A）

`POST /task`（委托派活）、`GET /status`、`dsh_task` / `dsh_task_status` 响应都带**非秘密**的 grant 定位/期限：

| 字段 | 含义 |
|---|---|
| `grantId` | 该任务的委托 grant id（等待循环据此做**认证续租**，不需要先手动查 grant） |
| `grantExpiresAt` | grant 绝对到期（授权窗口；续期只在其内延长） |
| `grantLeaseUntil` | 当前租约到期（每次 `status` 都刷新；客户端据此自适应续租节奏） |
| `grantStatus` | `active` / `revoked` / … |

MCP `waitTask` 的续租**跟着租约走**：轮询间隔 = 租约剩余/3（250ms–3s），剩余不足一个周期时发一次认证续租；1–5s 的短租约也不会被固定 10s 的节奏放过期。不传 `extendSec` 时只续**租约**，不延长绝对授权窗口（不扩大永久授权）。CLI 的**初次等待与 `--status-wait` 共用同一条路径**，同样自适应；两条路径的续租都必须由**认证调用**（带控制凭据头、匹配 task/origin/grant）触发，公开 `status` 不续。

**CLI 回归**（`test/approval-cli.test.mjs`，真实 CLI 进程 + 真实 HTTP）：`--delegate --no-wait` → exit 0 + 单个 prompt/grant + `grantId` 回显（缺 key → exit 2 且零派活）；`--delegate --delegate-lease 2` 的**初次默认等待**遇到 4.2s 才到的慢 ask → **exit 9**、初次路径上发生 ≥2 次认证续租、pending 随后可决定（不需要二次 `--status-wait`、不预查 grant）；同一次初次等待精确取回自己那条任务的 `completed` 结果；错来源 echo 不透 `result`。

## 8. 能力（capabilities.approvals）

| 能力 | 值 |
|---|---|
| supported / enabled | true / 看 key（缺 key 默认关闭） |
| sessionTargetSupported | true（`req.agent.session.id` 严格绑定；native 已证根监听可达） |
| workerSupported | **false**（child 身份未证明；worker+delegate 派活前拒绝，旧 worker 无委托路径不受影响） |
| ptcSupported | **false**（嵌套直接 `next()`） |
| canWakeIdle | **false**（不宣称 MCP/HTTP/收件箱能唤醒模型） |
| requiresExplicitEnable / activeOnly | true（提示/文本不构成授权；只在活跃循环内生效） |

## 9. 加载前提与测试

- 答复者是宿主 bundle 插件：**安装更新包 + 重启 profile** 后才在真实桌面生效；真机正例还需会话 `approval/policy=ask`（never 会先于答复者拒绝）、用户显式启用委托、动作限定授权范围内的无害操作。native/e2e 都是隔离证据，**不冒充真实桌面验收**。
- 测试分层：
  ```bash
  node --test test/*.test.mjs            # 全套 159
  node test/codex-approvals.test.mjs     # 核心（凭据/grant/快照/完整身份/认领/决定/恢复）
  node test/approval-e2e.test.mjs        # HTTP + 独立 MCP + 独立 CLI 闭环与负向
  node test/approval-hardening.test.mjs  # 第一轮 root 探测对应的加固回归（跨会话替换/上下文变更/双 ask/cancelled/wait 来源）
  node test/approval-window.test.mjs     # 第二轮 root 三个阻塞的回归（代际变化/忙锁/观察窗口）
  node test/approval-renewal.test.mjs    # 第三轮收尾回归（默认路径跨短租约续租/重复上报/reject 文案）
  node test/approval-cli.test.mjs        # 第四轮 CLI 入口回归（派活带认证/初次等待跨短租约/取回结果/错来源不透结果）
  node test/approval-native.test.mjs     # 真实 cordis/ApprovalService/scopeTarget（无 asar → skip 并显示原因）
  ```
- 观察窗口的环境变量：`DSH_BRIDGE_SESSION_QUIET_TIMEOUT_MS` / `DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS` 仍是**未委托**任务的旧预算；`DSH_BRIDGE_DELEGATED_GRACE_MS`（默认 5 分钟）是委托 grant 到期后的收尾宽限。测试用 50ms 预算证明"有效认证委托不被误收口"。
