# Changelog

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
