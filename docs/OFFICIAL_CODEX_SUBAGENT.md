# 可选集成：DSH 官方 Codex 子代理

`@whaletalk/dsh-codex-collab` 负责 **Codex → DSH** 的派活、已有会话接入、结果关联与授权审批。另行启用官方 `@deepseek-ai/dsh-subagent-codex` 后，DSH 可用 **`subagent_codex`** 调用一个独立的 Codex 执行器。两者可共存，官方运行时不加入本包的默认依赖。

## 安装两端

1. 按根 README 安装我们的 DSH 网关及 Codex 侧 MCP/CLI，并在 Codex 中安装启用 `dsh` 协作插件。
2. 在 DSH 的 desktop/web profile 单独安装并选中官方 Codex 子代理 bundle。选择与宿主配套的版本；不要把 npm 的 `latest` 标签当作宿主兼容性判断。例如 DSH `0.2.1-rc.2`：

   ```sh
   dsh plugin --profile desktop add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.2
   ```

3. 检查 DSH 中出现工具 `subagent_codex`。如果安装器提示需要重启，先结束当前任务再重启该 profile。本机上述版本的验证中，bundle 与配置均热加载成功，不需要重启。

官方包包含配套的 Codex 运行时，但不会替用户登录或生成账号。它按官方设计使用原生 Codex 配置与认证；不要把密码、token 或 `auth.json` 内容复制进仓库、聊天或本配置示例。

Codex 侧没有另一个必须配套安装的 `dsh-subagent-codex` 插件。现有 `dsh` 插件用于协调 DSH；官方子代理在 DSH 内部运行。

## 配置 provider

官方 bundle 已注册 `subagent-codex` 和 `tool-subagent-codex`。将[示例片段](../templates/codex-subagent/cordis.patch.yml)合并到现有 profile 的 `cordis.patch.yml` 数组中，**不要用它覆盖整个文件，也不要再次插入同名工具**。

- `permissionMode: never` 是官方默认值：不发起人工批准，仍受原生沙箱和策略限制，不代表自动批准所有操作。
- `model` 未配置时继承原生 Codex 选择。若该选择不被官方包附带的运行时支持，可仅在 `subagent-codex` 行覆盖模型，无须改动用户全局模型。
- 应先看该运行时的 `model/list` 目录，再用真实任务确认能否调用。目录可见并不保证账号可用。

本机集成验证发现：官方 `0.2.1-rc.2` 携带的 Codex `0.153.4` 对默认 `gpt-6.1-sol` 返回了“不支持 ChatGPT 账号”的 400；从其模型目录选择 `gpt-6-astra` 后，独立临时 profile 的真实口令任务以 `completed` 结束。其他安装应依据自己的运行时和账号验证，示例中的模型不是所有账号的强制默认值。

旧 `codex-mcp` 通道可继续用于持续对话。如果只需要官方一次性子任务，可在 profile 中显式将 `codex-mcp` 设为 `disabled: true`。这只关闭旧反向通道，不关闭 `dsh-bridge`。

## 任务边界

可在 DSH 中这样下达任务：

> 请用 `subagent_codex` 完成这个独立任务。给它完整目标、工作目录、约束和验收标准，并要求它直接完成本次委托，不再通过 `dsh_task` 或 `dsh_review` 把相同任务发回 DSH。完成后检查其真实产出和结果。

官方子代理每次使用新的临时线程、执行一个回合，接受独立文本任务；完成通知回到 DSH 父会话。它不会接入当前打开的 Codex 桌面对话，也不提供本插件的 queue/steer 或空闲桌面唤醒能力。

官方子代理里的权限请求由其原生 Codex 策略处理；我们的审批委托处理的是显式授权的 **DSH 会话任务**。两套权限范围不能互相替代，安装本可选后端不会自动签发或扩大审批 grant。

## 验证与排障

- 安装完成后确认官方 bundle 已选中、`subagent_codex` 工具出现；仅有包文件不等于工具已启用。
- 首次验证使用独立空目录和固定口令，不读取真实项目、不执行写文件操作。只有官方终态为 `completed` 且口令正确才算成功；握手或线程创建成功不等于模型请求成功。
- 若返回粗粒度 `product-error`，检查本机宿主日志中的实际模型/配置错误，并脱敏后记录；不要仅凭安装成功宣布可用，也不要反复重发真实用户任务。
- 本插件 `/api/dsh-bridge/debug` 的 provider 列表可用于辅助确认 `codex` 已注册。Codex 的 DSH MCP 应连接当前网关地址，服务重启换端口后需同步更新。
- Codex 插件安装、启用与 MCP 配置完成后，已打开客户端可能仍持有旧连接；重新连接后检查工具列表。当前协作服务器提供 9 个 MCP 工具，`subagent_codex` 则是 DSH 内部工具。

参考：[官方子代理说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/README.md)、[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
