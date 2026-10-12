# DSH → Codex 收件箱（M0 降级交付）

> **状态：收件箱已完成（含跨进程写事务与记录边界修复）；桌面自动唤醒尚未完成。**
> M0 实测本机没有可附着的 Codex Desktop 端点（证据见
> [`codex-desktop-attachment-evidence.md`](codex-desktop-attachment-evidence.md)），
> 因此"DSH 主动发消息并**触发**那条聊天回复"被标记为 **blocked**。
> 本文交付的是它可独立验证的那一半：一个**跨进程安全**的本地消息收件箱。

## 1. 它现在能做什么 / 不能做什么

| | 状态 |
|---|---|
| DSH 侧把要说的话写进本地持久化收件箱（写盘成功才算 `queued`） | ✅ 已完成 |
| 未绑定目标一律拒绝，绝不猜或静默新建 | ✅ 已完成 |
| 幂等（同键同文返回原 messageId）、冲突（同键异文明确报错） | ✅ 已完成 |
| **跨进程**：并发写入经一把文件锁串行化（幂等检查 / seq 分配 / 绑定更新 / 追加） | ✅ 已完成（真多进程验证） |
| **记录边界**：残尾（半行）不会吞掉后续写入 | ✅ 已完成 |
| 每个绑定内严格按序；重启后队列与状态恢复 | ✅ 已完成 |
| 状态机与结果关联（queued → delivered → acked，可回填回复与 turnId） | ✅ 已完成 |
| 存储损坏/不可读时**明确报错**，不伪装成空收件箱 | ✅ 已完成 |
| 能力如实上报（`canWakeIdle:false`、`deliveryMode:'inbox'`） | ✅ 已完成 |
| **自动唤醒 Codex Desktop 聊天、观察其回合事件** | ❌ **blocked**（M0 未通过） |

Codex 侧目前需要**主动来读**：`codex-inbox pending` → `codex-inbox ack`。
这条路径不假装成唤醒——`capabilities` 里永远是 `deliveryMode: 'inbox'`。

## 2. 快速上手

存储默认在 `~/.dsh-codex-inbox`（`--root` 或 `DSH_CODEX_INBOX_DIR` 可改），**不写入仓库**。

```bash
# 0) 先看能力（永远显示 inbox-only，不会谎报唤醒）
node mcp/codex-inbox.mjs capabilities

# 1) 显式绑定一条目标聊天（bindingId 自己起名；threadId 必须由人/Codex 明确给出）
node mcp/codex-inbox.mjs bind \
  --binding dsh-codex-collab \
  --thread 01a100f1-045c-7e10-84c7-ac8ec37eff3f \
  --source session-dd9655aa-b99f-4e36-b914-a5035fd094e1 \
  --note "本地实验绑定，不作为发布默认值"

# 2) DSH 侧发一条（写盘成功才返回 queued）
node mcp/codex-inbox.mjs send --binding dsh-codex-collab \
  --text "请原样回显：DSH_TO_CODEX_xxxxxxxx" --key canary-001

# 3) Codex 侧/用户来读
node mcp/codex-inbox.mjs pending
node mcp/codex-inbox.mjs show <messageId>

# 4) 确认处理并回填结果
node mcp/codex-inbox.mjs delivered <messageId> --by codex-side
node mcp/codex-inbox.mjs ack <messageId> --reply "DSH_TO_CODEX_xxxxxxxx" --turn turn-xxx
```

## 3. 语义与退出码

**状态**：`queued` → `delivered` → `acked`；另有 `failed` 与 `delivery-unknown`
（后者留给将来接入适配器时"请求已发出但连接断了、无法确认服务端是否接受"——**故意不叫 failed**，
免得调用方当成"没发出去"而盲目重发）。

**幂等**：同一 `bindingId` + 同一 `--key` 且正文一致 → 返回原 `messageId`（`duplicate:true`，不新增）；
正文不同 → `idempotency-conflict`（exit 4，不覆盖、不新建）。

**顺序**：每个绑定一个 `seq`，`pending` 按它返回；绑定之间互不影响。

**参数是严格的**：除 `--help`/`--json` 两个布尔旗标外，**带值旗标缺值、或出现未知旗标一律 exit 2**，
且校验发生在打开存储、做任何变更**之前**——因此 `ack --reply`（缺值）不会把 `true` 当 undefined
照常确认，`send --key`（缺值）不会静默丢掉幂等键，`--root`（缺值）不会回落到真实默认目录。

**退出码**：`0` 成功 / `1` 失败 / `2` 用法 / `3` 未绑定 / `4` 幂等冲突 / `5` 未知消息 / `6` 非法状态转移。

**失败原因（稳定字符串）**：`unbound-target`、`binding-thread-mismatch`、`invalid-input`、
`idempotency-conflict`、`illegal-state-transition`、`unknown-message`、`lock-timeout`（活持有者，可重试）、
`lock-stale-holder`（持有者已死，需人工清理）、`lock-unverified-holder`（元数据不可确认，需人工清理）、
`store-unreadable`、`store-corrupt`、`write-failed`。

## 4. 可靠性：已验证到什么程度（不夸大）

**互斥就靠一条**：写锁是**一个共享路径** `<root>/.write.lock`，进入临界区只靠**一次原子独占创建**
（先把完整元数据写进唯一命名的 `pending-<token>.json`，再 `linkSync` 到锁路径；平台不支持硬链接时退化为
`wx` 独占创建 + 立即写入）。共享路径只能被创建成功一次，所以同一时刻至多一个写者——这一点不需要任何
"编号/选举/租约"机制。

**在线竞争期间绝不自动回收锁**。原因：在共享路径上"检查持有者 → 再删除/改名"无法原子化——回收者可能
删掉别人刚创建的新锁（ABA/TOCTOU）。这一点在评审里被真实复现过两次（先删共享锁、后复用编号），所以现在
不做任何自动回收：

| 情形 | 行为 |
|---|---|
| 持有者活着 | 等待到 `lockTimeoutMs`，报 `lock-timeout`（可重试）——**不抢** |
| 持有者已死 | **二次确认**（锁仍在、仍是同一把、pid 仍不可达）后报 `lock-stale-holder`（可恢复错误）——**不自动删** |
| 元数据空/损坏 | 报 `lock-unverified-holder`（可恢复错误）——**不按时间偷** |

"二次确认"是必需的：持有者可能**刚刚正常释放并退出**（我们读到内容之后、检查存活之前），此时若直接判 stale 就会误报；
确认后发现锁已不在就重试获取。即便确认之后仍有极小窗口，最坏也只是报一次可恢复错误——**绝不会删除活锁，也不会产生双写者**。

**人工恢复步骤**（文档化的降级路径）：确认**没有任何写入进程在运行**（收件箱使用者都是本机 CLI/进程，
没有后台常驻写者），然后删除 `<root>/.write.lock` 即可继续。CLI 报错时会打印该文件路径。

已验证（`node test/codex-outbox.test.mjs`，**23 项**；并发项都是**真多进程**）：

- 残尾：写入一条后手工追加半个 JSON 行（不带换行），随后 `enqueue` 必须成功且能查到新 `messageId`；
  重开后两条都在，残尾作为坏行跳过。「完整但缺结尾换行」的记录也不丢、不串行。
- 4 进程同 key 同文并发 → 只有 1 条消息、只有 1 个 `duplicate:false`、`seq=1`。
- 4 进程异 key 并发 → 4 条、`seq` 恰好 `{1,2,3,4}`；**6 进程压测** → 6 条、`seq` 唯一连续 {1..6}。
- 并发绑定：不同 id 都落地；同 id 同 thread 不重复；同 id 异 thread 只成功一个；不残留临时文件。
- **活持有者期间**：两个真实进程只能等待，`messages.jsonl` **零写入**、锁文件**字节未变**；
  持有者释放后两者串行完成，同 key 仍只有 1 条消息。
- 死持有者 → `lock-stale-holder`：锁文件**原样保留**、零写入；按恢复步骤人工删除后可继续。
- **持有者在被读到时刚释放**（确定性钩子复现）：必须二次确认后重试并成功，**不得误报 stale**（这条回归对旧逻辑是失败的）。
- 活持有者超时 → `lock-timeout`：锁文件**原样保留**、零写入。
- 元数据空 / 非法 JSON / 无 pid → `lock-unverified-holder`：文件**字节未变**、零写入。
- 绑定表损坏（非法 JSON / 形状不对）→ `store-corrupt`，**不退化**成"没有绑定"。
- 正常路径结束后：无锁文件残留、无 `pending-*` 残留。

**未验证 / 明确不声称**：

- **死持有者会一直阻塞**（直到人工清理）：这是"宁可 fail closed 也不冒双写者"的代价，**不是自动恢复**。
- **断电级持久性**：写入是 append + 边界修复，没有 fsync 屏障，不承诺掉电后零丢失。
- **跨机器/网络文件系统**：锁依赖本机的原子独占创建（link/`O_EXCL` 语义）；NFS 等共享文件系统未验证。
- 早期版本试过"编号 claim + 选举 + 自动回收"，**已被判定为不成立并整块删除**：
  释放只是把 `<n>.claim` 改名为 `<n>.released`，同一个 `<n>.claim` 路径会重新可创建，
  迟到的发布者能复用已释放编号并插队（评审给了确定性复现）。现在不再有任何"编号/选举"机制。
- **真正的"自动唤醒"链路**（M0 仍 blocked）。

## 5. 独立验证

```bash
node test/codex-outbox.test.mjs        # 24 项：语义 + 记录边界 + 真多进程并发/压测 + 独占写锁 + 存储损坏
node test/codex-inbox-cli.test.mjs     # 6 项：CLI 进程级（exit code / 缺值不碰存储 / 状态不变）
node test/codex-desktop-probe.test.mjs # 11 项：doctor 纯判定 + 采集层解析 + 端到端只读运行
node mcp/codex-desktop-probe.mjs --schema   # 现场能力报告（含祖先链归属与协议方法面）
```

实测记录（2026-10-12，本机 Windows）：

- 队列 **24/24** 通过（连跑 5 次均为 24/24，无 flaky）；含 4/6 进程并发、并发绑定、活持有者期间零写入、
  死持有者二次确认后 fail closed、元数据不可确认 fail closed、残尾续写、持有者刚释放的确定性回归。
- CLI **6/6** 通过：缺值/未知旗标 exit 2 且不创建存储、不改状态（queued 仍是 queued、无新消息）。
- 探针 **11/11** 通过：采集层"非终止错误 + exit 0 + 空 stdout"必须判为失败（不再是"扫描成功且为空"）；
  扫描失败 → `probe-inconclusive`；端点信号 → `endpoint-present-unverified`；
  **桌面身份要求祖先链先遇到桌面 App**——先穿过另一份 app-server 的派生实例单列、不算桌面端点。
- 现场探针：只有直挂 `ChatGPT.exe` 的主实例算 desktop；两个经 `node_repl` 派生的实例单列 standalone；
  控制套接字不存在、daemon 连接失败 → `desktop-attachment-unavailable`。
- 根代理的三个故障演示脚本在新代码上**都不再复现**（都只是旧触发条件消失，**不作为通过依据**）：
  `review-inbox-reliability.mjs` 在其第一条断言处失败；
  `review-inbox-stale-lock.mjs` 报 `Barrier timeout: a-read-stale`；
  `review-inbox-ticket-reuse.mjs` 报 `barrier timeout: B-before-link`（它拦截的 `<n>.claim` 已不存在）。
  真正的依据是上表里新增的活持有者 / fail-closed / 高争用回归。

## 6. 未实现的部分（以及为什么先不做）

按计划"不为不可用的通道搭大框架"：

- **没有** DSH 插件内的 `dsh_codex_send` / `dsh_codex_targets` / `dsh_codex_status` 三个工具与 HTTP 路由
  （现有六个 MCP 工具与 `dsh_collab_send` 语义**未做任何改动**）。等 M0 成立、确有可用投递入口时再按 M1 契约加。
- **没有**桌面接收适配器（无端点可连）。
- **没有**因此更新 `package.json` 打包清单 / CI 断言——能力未落地的部分不进发布面。
- 未打 tag、未 npm 发布（按授权要求，先保留可审查 diff）。

## 7. 什么时候能变成"真唤醒"

一旦 `codex-desktop-probe` 报告 `endpoint-present-unverified`（例如桌面以 `--listen ws://…` 启动，
或平台提供了文档化的本机控制端点），就按计划 M1–M3 补齐：显式目标绑定校验、
`dsh_codex_send/targets/status`、适配器（initialize → `thread/loadedList` 命中 → `turn.start` →
观察 `turn.completed`）、busy 排队、`delivery-unknown` 恢复、回复关联与防循环，
并在真实桌面做 canary 验收后，才把 `canWakeIdle` 置为 true。
