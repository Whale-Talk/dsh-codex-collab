# Changelog

## 0.1.12 — 2026-11-11

- 适配 **Codex CLI 0.167**：`codex mcp-server` 已被移除（`codex help mcp-server` → `unrecognized subcommand`）。bundle 的 `cordis.patch.yml` 自本版起**不再内置 `codex-mcp` 反向通道**（旧配置在新版只剩静默失败）；仅旧版 Codex（≤ 0.1xx）需要时，按 `templates/codex-mcp/` 手动合并该 `insert` 行。
- Codex 侧安装改用 0.167 的官方命令：`codex plugin marketplace add` + `codex plugin add` + `codex mcp add`（README / `templates/codex-mcp` / `docs/OFFICIAL_CODEX_SUBAGENT.md` 同步更新）。DSH→Codex 新版路径推荐官方 `@deepseek-ai/dsh-subagent-codex`（工具 `subagent_codex`）。
- 适配 **DSH 0.2.2-rc.1 的 provider 名变化**（`subagent` → `spawn`/`fork`，并存外部 `codex` provider）：provider 选择改为显式白名单 `subagent → spawn → fork`，**外部 `codex` provider 永不被自动选中**（避免 DSH 编码工人被误派给 Codex CLI）；可用 `DSH_COLLAB_SUBAGENT_PROVIDER` 显式覆盖（外部 provider 会被拒绝）。`/api/dsh-bridge/debug` 新增 `provider` 字段显示实际选择。
- 新增回归：spawn/fork 优先、`codex` 排除、环境变量覆盖（3 项）；宿主守卫新增 bundle patch 反向通道退役断言。测试总数 **242**。
- README 增加「把 DSH 桌面端固定到 3080」的 profile patch（`webserver` 行覆盖），使 Codex 的 `DSH_BRIDGE_URL` 长期有效；桌面端默认随机端口、每次重启都会变。
- 生产派活/审批/来源绑定/模型路由契约不变。

## 0.1.11 — 2026-11-06

- 适配 DSH **0.2.2-rc.1**：真实 SDK 契约测试改用新的会话投影机制（`ApprovalService` 现在通过 `ctx.sessionProjections` 读 policy/turnOpen；回合/步进边界由 `dsh-agent` 的 `turnBoundaryOf(session)` 投影提供，`dsh-agent-loop` 不再导出该定义）。断言的行为不变，236 项全部通过。
- 声明 `engines.dsh`（`>=0.2.0-0 <0.3.0`），让 DSH 的插件兼容检查在宿主跨大版本升级时直接拒绝装载而不是运行期出错。
- 新增宿主契约守卫测试 `test/dsh-compat.test.mjs`：只读当前安装的 `app.asar`，核对 DSH 版本落在声明范围内，并逐项检查本插件依赖的 SDK 入口仍存在（`defineTool`、`sessionProjections/stateOf`、`turnBoundaryOf`、`startActivation`/`isOwnedBy`、`agent/inbox/claimed`/`agent/request-error`、`listProviders`/`listModels` 等）。DSH 再次升级时可第一时间暴露漂移。
- 生产逻辑无行为变更；审批委托、来源绑定 queue/steer、模型目录与自动选择/有界故障切换契约保持不变。

## 0.1.10 — 2026-10-20

- 修复大对话每 2.5 秒全量读取：同会话共享 SDK 增量事件/有界 follow，低成本观察只用于初始化或补缺；慢检查互斥、失败退避，空闲 worker 零历史读取。
- 审批/模型选择复用连续证据索引，关键决定仍做新鲜核验；缺口、卸载、缓冲溢出时安全停止取证，不以过期缓存放行。
- 模型审计状态读取改为缓存最近 1 MiB，保留完整原始审计文件；debug 新增观察计数与审计尾部统计。
- 兼容 DSH 0.2.1 的 `startActivation`（同时保留 0.2.0 入口）；worker 未确认时保留唯一归属，迟到的官方结束仍结算原任务。
- 一并发布已验收的审批委托、来源绑定的 queue/steer、模型目录及 DeepSeek 优先自动选择/有界故障切换；MCP 工具共 9 个。
- 增加共享观察、快照补缺、慢读竞态、失败退避、缓冲上限和审计回归；保留上游署名和 MIT 许可。

## 0.1.9 — 2026-10-13

> **0.1.8 从未发布到 npm。** `v0.1.8` tag 建立后，CI 的 Linux gate 在 `test/codex-associations.test.mjs` 暴露了一个**仅测试代码**的跨平台断言缺陷：
> 读取"目录位置被文件占住"的路径时，Linux 报 `ENOTDIR`（抛 `store-unreadable`）、Windows 报 `ENOENT`（落 `unknown-task`），而原断言只认后者。
> 已把该断言改为跨平台不变量（写失败必须抛错；读失败必须响亮、且不得带出 record）。按"不得覆盖既有 tag/version"的规定，本版改用 **0.1.9** 发布；
> **功能内容与 0.1.8 完全相同**（tag `v0.1.8` 仍指向当时的提交，未被移动）。

### 来源关联（R1）：Codex 派活 → DSH 执行 → 按来源精确收回

- **持久绑定**：`dsh_task` / `dsh_review`（MCP）、`POST /api/dsh-bridge/task|review` 与 CLI 新增可选 `originThreadId`（发起这次派活的 Codex 对话 id）。
  网关在**执行前**把「来源对话 → taskId → 执行目标」落盘到 `~/.dsh-codex-task-assoc/<namespace>/bindings.jsonl`（追加型 JSONL + 独占写锁，`DSH_CODEX_TASK_ASSOC_DIR` / `DSH_BRIDGE_ASSOC_NAMESPACE` 可覆盖）；
  **首次绑定失败就不启动执行**，终态/失败/取消/交付确认都写回。
- **跨回合/跨进程收取**：`dsh_task_status`（MCP）与 `dsh-task --my-tasks` / `--status <taskId> --origin <id>`（CLI）按 `origin + taskId` 精确取值，或只给来源列出该对话登记过的任务（找回丢失的 taskId）。
  缺来源 → `origin-required`、错来源 → `origin-mismatch`，**绝不返回别的对话的结果**；旧的无来源调用保持兼容。
- **会话任务按请求回合关联结果**（不再依赖"派发前基线 + 全会话 idle"）：`prompt.requestId` → `user/message.source.rpcId` → 按 `seq` 有序跟踪未闭合 turn → 只收**自己那个 turn** 的助手文本；
  **只有 `turn/end` 的 `reason.kind === completed` 算成功**，`aborted/blocked/error/max-tokens/interrupted/forked` 是明确失败（部分文字进 `partialResult`）。
  follow 开场的 `snapshot.records` 也会被检查（快任务可能已跑完）；`api-session/status` 只当作"读一次日志的机会"，**不是**完成证明；没有证据 → `status:"unknown"` + `resend:false`（不猜 done、不重发）。
- **带来源时拒绝 `steer`**（`origin-steer-unsupported`，执行前拒绝、零投递）：若干请求会共用同一个 turn，无法为单个请求保证归属。
- **能力握手**：`/status`、`/tasks`、`/debug` 上报 `capabilities.originBinding`；MCP/CLI 带来源时先只读核验（不靠包版本猜），旧网关 → **零执行拒绝**；
  网关接受请求但未回显匹配的 `originThreadId` → 按"未确认、不要重发"上报（CLI 退出码 8）。
- **同通道单在途**：同一 `cwd + lane`（评审=同目录）有在途任务时明确 `worker-bucket-busy` / `reviewer-bucket-busy` 拒绝，避免完成结果归属靠猜；不同 lane/目录仍并行。

### DSH → Codex 收件箱与只读探针

- `mcp/codex-inbox.mjs` + `harness/codex-outbox.mjs`：追加型事件日志 + **单把独占写锁**（`harness/fs-lock.mjs`，与关联存储共用同一实现；在线竞争期间绝不自动回收，死持有者/不可确认元数据都 fail closed 并给人工清理步骤）。
- `mcp/codex-desktop-probe.mjs`：只读能力探针；采集层 `-ErrorAction Stop` + 显式 payload 标记，**非终止错误不会被当成"扫描成功且为空"**；
  桌面身份要求祖先链先遇到安装式桌面 App（穿过另一份 app-server 的派生实例单列）。
- **桌面自动唤醒仍为 blocked**（M0：本机桌面 app-server 以 `stdio://` 由 `ChatGPT.exe` 私有持有，无可附着端点）；`canWakeIdle` 恒为 `false`，本版不宣称自动唤醒。

### 验证

`node --test test/*.test.mjs`：**117 项**通过（含真实 `http.Server` + 独立 MCP/CLI 进程的跨回合收取、重启恢复、旧网关零执行拒绝等端到端用例）；
另通过 Codex 侧独立正向契约检查（入口 12/12、会话关联 4/4）与真实 canary。
