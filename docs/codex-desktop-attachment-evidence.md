# M0 证据：Codex Desktop 桌面接入能力（本机 Windows）

- 首次记录：2026-10-10；**复核更新：2026-10-12**（桌面重启后 PID 变化，结论未变）
- 仓库：`E:/11-Github/dsh-codex-collab`
- 计划：`docs/DSH_TO_CODEX_MESSAGING_PLAN.md`
- **结论：M0 未通过 —— 本机不存在可附着的桌面端点。桌面自动唤醒处于 blocked。**
- 文中 PID / 安装路径均为**当次现场信息**，仅作证据；实现里一律不硬编码（探针每次现场读取）。

## 1. 一句话结论

桌面 Codex（ChatGPT.exe）把 app-server 以**默认 `stdio://`** 启动，stdin/stdout 归父进程私有；
本机既没有 `--listen` 出的 ws/TCP 端点，也没有文档所说的 app-server 控制套接字。
因此在"**不启动第二份 app-server**"的前提下，第三方无法连到桌面正在使用的那个后台，
`thread/loaded/list` 与 canary 都无法进行。协议本身具备所需方法（见 §4），缺的只是**传输**。

## 2. 现场事实与证据（2026-10-12 复核）

| # | 探测项 | 实测结果 | 证据来源 |
|---|---|---|---|
| 1 | 桌面 App | `ChatGPT.exe`（PID 11768），Store 包 `OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0` | 进程扫描 |
| 2 | 桌面 app-server | PID 17068，`codex-cli 0.162.0-alpha.17.2`（bundled CLI），**祖先链**：`17068 ← ChatGPT.exe(11768)` | 探针 `desktop[].why` |
| 3 | 同一桌面的其它 app-server | PID 19848、53256，同样 `--listen stdio://`；祖先链 `app-server ← node_repl.exe ← node.exe ← 17068 ← ChatGPT.exe(11768)` | 探针 `desktop[].ancestry` |
| 4 | app-server 启动参数 | 桌面主实例：`-c features.code_mode_host=true app-server --analytics-default-enabled …`（**无 `--listen`** → 默认 `stdio://`）；另两个显式 `app-server --listen stdio://` | 进程命令行 |
| 5 | TCP 监听 | 三个实例 **tcp=[]**（无任何 LISTEN 端点） | 探针 `listenerScan` |
| 6 | 控制套接字 | `C:\Users\Marx\.codex\app-server-control\app-server-control.sock` **不存在** | 探针 `controlSocket` |
| 7 | daemon 路径（bundled CLI） | `app-server daemon version` → `Error: failed to connect to …app-server-control.sock` / `os error 10050` | 探针 `daemonProbe` |
| 8 | daemon 路径（全局 CLI 0.147.0） | `app-server daemon version` → `Error: codex app-server daemon lifecycle is only supported on Unix platforms` | 2026-10-10 实跑 |
| 9 | `proxy --sock` | 帮助里出现，但目标是"app-server **Unix domain socket**"；实跑 → `failed to connect to socket at …` + `os error 10050`。**帮助里有 ≠ 可用** | 2026-10-10 实跑 |
| 10 | 命名管道 | 41 个 codex 管道（`codex-browser-use-*` / `codex-computer-use-*` / `codex-ipc` / 沙箱服务）。`codex-ipc` 字符串**存在于 CLI 二进制内** → Codex 内部 IPC，非文档传输；**未连接、未使用** | 探针 `namedPipes` |
| 11 | 协议方法面 | `app-server generate-json-schema --out <临时目录>` 成功；含 `v1/InitializeParams`、`v2/ThreadLoadedListParams`、`ThreadRead/List`、`TurnStart/Steer/Interrupt`、`ThreadInjectItems` | 探针 `schema.keyMethods` |
| 12 | 历史（2026-10-10） | 当时为 `ChatGPT.exe 44100 → app-server 24776`，其余结论相同 | 前一版记录（PID 仅是历史，不作依据） |

## 3. 被排除的替代路径（以及为什么）

| 路径 | 为什么不用 |
|---|---|
| 自己起 `codex app-server --listen ws://…` | 那是**第二份 app-server**（独立存储/独立线程注册表）。用它 `thread/resume` 同一 ID 只能证明"磁盘上能读到这个 ID"，**不能证明连上了桌面正在用的后台**——计划明文禁止以此冒充投递成功 |
| `app-server daemon start/bootstrap` | 该生命周期在本平台不可用（§2 #7/#8）；即便可用也仍是第二实例；`enable-remote-control` 属未授权变更 |
| `codex app-server proxy` | 依赖不存在的 Unix 控制套接字（§2 #9） |
| 直写桌面会话存储 / rollout 文件 | 计划禁止；写入磁盘不会让那条聊天产生回合，不满足验收 |
| **同一份存储目录** | **不能证明是同一后台**：探针刻意不把 storage 当证据；判定只看祖先链与端点是否存在 |
| `\\.\pipe\codex-ipc` 私有 IPC | 计划明令不得以"私有 IPC 猜测"凑通路；未做连接尝试 |
| 普通 MCP notification / Work Cloud 的 MCP Events | 前者不会唤醒本地聊天，后者适用范围是 Work 产品线，**都不算本地桌面唤醒** |
| 重启 Codex/DSH 以带 `--listen` 启动 | 未获授权（且会中断正在进行的回合） |

## 4. 结论与能力边界

- **协议可行、传输阻断**：所需方法在 schema 中都存在，"投递并观察回合"在协议层可表达；
  缺的是**一条被支持的、指向桌面现有后台的传输**。
- 降级交付 = **收件箱模式**。能力如实上报（`codex-inbox capabilities` / `codex-desktop-probe`）：

  ```json
  {
    "available": false,
    "deliveryMode": "inbox",
    "canWakeIdle": false,
    "canObserveTurns": false,
    "reason": "desktop-attachment-unavailable"
  }
  ```

- **明确不宣称**：桌面自动唤醒、在线长等待、回合事件观察均**未实现**。
- 授权目标线程 `01a100f1-045c-7e10-84c7-ac8ec37eff3f` 与来源会话
  `session-dd9655aa-b99f-4e36-b914-a5035fd094e1` 仅登记在**本地实验绑定**里（收件箱用），
  **未**写入任何发布包默认值。因为没有投递入口，**canary 未发送**（无路可发，不是失败）。

## 5. 探针的判定纪律（2026-10-12 强化）

`mcp/codex-desktop-probe.mjs` 的判定是**纯函数**（`classifyProcesses` / `decideCapabilities`），
采集层解析（`parseScanOutput`）也是纯函数，都可离线测试：

1. **桌面身份靠祖先链证明，且另一份 app-server 会遮断归属**：命令行里出现 `app-server` 不足以认定桌面；
   必须**先**遇到安装式桌面 App（`ChatGPT.exe`/`Codex.exe` 位于 `WindowsApps`/`Programs`）。
   祖先链里若**先**遇到另一份 app-server，说明该实例是由那份后台派生的（桌面运行时 `node_repl`/`node`
   就会派生这种实例）→ 单列为 `standalone`，**不能算作桌面正在使用的后台**。
   祖先链拿不到的进 `unidentified`。
2. **同一份存储不能证明是同一后台**：探针不使用 storage 做判定，只在报告里附注。
3. **采集层必须 fail loud**：PowerShell 查询一律 `-ErrorAction Stop` 并显式传播失败；脚本用
   `DSH_PROBE_JSON:` 标记 + 退出码区分"结果为空"与"没有结果"。**非终止错误 + exit 0 + 空 stdout
   绝不能被当成"扫描成功且结果为空"**——那会让探针从"没查到"误推成"没有端点"。采集解析失败 →
   `probe-inconclusive`，不是 `unavailable`。
4. **存在端点信号 → `endpoint-present-unverified`**：桌面 app-server 用了非 stdio 的 `--listen`、
   或控制套接字存在、或 daemon 探测成功，任一成立即报此结论（**不因为"没有 TCP 监听"就声称没有端点**）。
5. **`canWakeIdle` / `canObserveTurns` 恒为 false**，直到真的完成协议校验与同一聊天 canary。
6. `--schema` 生成的临时目录在**递归删除前**显式校验解析后的目标位于系统临时根之内。

## 6. 什么条件下可以重新评估 M0

出现以下任一情形即可重跑 `node mcp/codex-desktop-probe.mjs --schema` 复核：

1. 桌面版本/配置使 app-server 以 `--listen ws://127.0.0.1:<port>`（或 Windows 上可用的 `unix://`）启动；
2. 桌面提供**文档化的**本机控制端点（例如 `app-server-control` 在本平台真实存在且可连）；
3. 官方为 Windows 提供可用的 app-server daemon 生命周期。

届时 M0 需重做：连上**同一后台** → `initialize/initialized` → `thread/loaded/list` 命中目标 →
`thread/read` 取证 → 观察运行中回合 → 空闲后 canary。

## 7. 本次未做的操作（合规声明）

未修改 Codex 配置或权限模式、未启用远程控制、未重启 Codex/DSH、未读取或输出任何凭据
（`auth.json` 等一律未读）、未改写会话存储、未模拟点击、未修改上游、未打 tag、未 npm 发布。
除可选的临时 schema 目录（用后即删，且删除前校验路径）外探针只读；收件箱默认写在
`~/.dsh-codex-inbox`，**不写入仓库**。

## 8. 复现命令

```powershell
# 一条命令给出结论（含祖先链归属与协议方法面）
node mcp/codex-desktop-probe.mjs --schema

# 手动复核
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'app-server' } |
  Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine
Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in <上面的 pid> }   # 期望为空
Test-Path "$env:USERPROFILE\.codex\app-server-control\app-server-control.sock"            # 期望 False
```
