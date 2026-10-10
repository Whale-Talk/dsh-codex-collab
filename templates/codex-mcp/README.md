# templates/codex-mcp —— 反向通道：让 DSH 调用 Codex

把 **Codex CLI 当作 MCP 服务端**挂进 DeepSeek Harness，于是 DSH 侧的 agent（包括
本插件派出去的 worker）会拿到 `mcp__codex__*` 工具，可以把活**交回 Codex**。

- DSH 侧负责连接的是 harness 自带的 `@deepseek-ai/dsh-mcp-client`（把外部 MCP
  服务器的工具注册进 `ctx.tools`，支持 `stdio` 与 `streamable-http`，带断线重连）。
- Codex 侧负责暴露的是 `codex mcp-server`（stdio）。

## 装法

**A. 并进你现有的 profile patch**（推荐，最少文件）：把 `cordis.patch.yml` 里那行
`insert` 追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml` 数组末尾。

**B. 当作独立 bundle 安装**：

```sh
dsh plugin --profile desktop add "<本目录绝对路径>"
```

两种方式都一样：**装完必须重启 profile 进程**（新增组合包不会热挂载），
重启后工具才会出现在列表里。

## 配置要点

| 字段 | 说明 |
|---|---|
| `serverName` | 工具命名空间，工具名形如 `mcp__codex__<tool>`；同时挂多个服务器时各自独立 |
| `transport` | `stdio`（本地进程）或 `streamable-http`（远端） |
| `command` / `args` / `env` / `cwd` | 仅 stdio：可执行文件、参数、追加环境变量、工作目录 |
| `failOnStartupError` | `false` = 连不上也照常启动 harness，只是没有这批工具 |
| `toolCallTimeoutMs` | 每次 `tools/call` 超时；**默认只有 60s**，Codex 跑一轮常常不够，建议 600000 |

### Windows 的坑（必读）

npm 安装的 `codex` 是 `.cmd` 垫片，而 DSH 的 stdio transport 是**直接 spawn**
（不经过 shell）——在 Windows 上 spawn 一个 `.cmd` 会 `EINVAL`。三种可用写法：

```yaml
# 1) node 跑垫片背后的 JS（模板默认，可移植）
command: node
args: ['C:\Users\<you>\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js', 'mcp-server']

# 2) 直接指向平台二进制（最稳，路径随版本/架构略有不同）
command: 'C:\Users\<you>\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
args: ['mcp-server']

# 3) macOS / Linux：垫片本身可执行，直接写命令名
command: codex
args: ['mcp-server']
```

## 验证

```sh
codex --version                 # 需要 CLI 已登录可用
codex mcp-server --help         # 应打印 "Start Codex as an MCP server (stdio)"
```

接好后在 DSH 侧让 agent 调一次 `mcp__codex__*`；工具没出现就去看 harness 日志
（连接失败会记录原因，且不会中止启动）。

## 能做什么、不能做什么

| | 可行性 |
|---|---|
| 让 DSH 调用 Codex（当执行器/评审员） | ✅ 本目录的做法 |
| 让 DSH 往你**正开着的某条 ChatGPT/Codex 对话**里插消息、就地开一轮 | ❌ 做不到 |

原因：现有链路是 Codex 主动（它启动 `dsh-mcp` 子进程调工具），MCP 是**客户端发起**
的协议，服务端无法命令客户端开一轮；服务端→客户端只有 `notifications/*`（不触发
回合）、`sampling/createMessage`、`elicitation/create`（取决于客户端实现，且不等于
"在对话里跑工具"）。ChatGPT 侧同样没有公开 API 能向用户会话投消息。

> 另注：本插件自带的 `dsh_collab_send` / `dsh_collab_review` 是 **DSH 侧入口**，
> 它们只回到同一个网关，**不经过 Codex**。
