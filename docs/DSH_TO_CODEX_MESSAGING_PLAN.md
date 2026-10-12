# DSH 主动向当前 Codex 聊天发送消息：方案与实施计划

日期：2026-10-10
项目：E:/11-Github/dsh-codex-collab
执行者：DSH 中已有的“dsh-codex-collab 项目”对话
计划状态：可执行；桌面后端附着能力须先通过 M0 验证，尚未承诺当前 Windows 环境已可附着。

## 1. 用户目标与完成标准

用户在 DSH 对话中要求“告诉 Codex 某件事”，DSH 向已经明确绑定的一条 Codex Desktop 聊天发送消息；Codex 在同一条聊天中收到消息并开始处理。Codex 正忙时默认排队，保持原来的上下文、模型、工作目录和权限。

完整验收必须同时满足：

1. 用户原来打开的那条聊天收到带唯一标记的消息，并产生对应的 Codex 回复。
2. 线程 ID 与绑定的目标一致，没有新建或 fork 另一条聊天。
3. Codex 不必先主动派一个 DSH 任务，DSH 能主动发起投递。
4. 忙时按队列顺序处理；没有明确的打断授权时不 steer、interrupt 或 cancel。
5. 发件人能查到消息状态和失败原因，超时或重连不会悄悄重复启动回合。
6. 重启后绑定、待投递消息和查询状态可以恢复；原有六个 MCP 工具和 DSH 派活/评审功能继续正常。

“调用另一个 Codex CLI”“写入 rollout 文件”“只有工具结果回传”“同 ID 在另一个进程能读到”“仅写入收件箱”均不满足完整验收。没有桌面接入能力时，可以交付独立可测试的收件箱，但必须明确报告完整目标仍被阻塞。

## 2. 已有事实、来源和未知项

- 项目源码当前为 0.1.7；本机 npm/Codex 插件为 0.1.6。
- 已有 cordis.patch.yml 使用 DSH MCP 客户端启动 codex mcp-server，供 DSH 调用独立的 Codex CLI；这不是当前桌面聊天的投递入口。
- dsh_collab_send 实际回到本地 DSH enqueue；其 sessionId 指向 DSH 会话，不是 Codex 线程。保留该接口的既有语义。
- 全局 Codex CLI 为 0.147.0；桌面运行的是 bundled 0.162.0-alpha.17.2。本次观察到桌面 app-server 没有显式 --listen 参数；PID 和安装路径是临时现场信息，禁止硬编码。
- 全局 CLI 的 app-server daemon version 在 Windows 实际返回：daemon lifecycle is only supported on Unix platforms。proxy 帮助出现 --sock 并不能证明 Windows 或桌面后端支持。
- 当前任务的 Codex 线程 ID 可从受信任的 CODEX_THREAD_ID 取得。该值仅用于本次绑定/验收，禁止作为发布包默认目标。
- App Server 提供线程与回合协议；读取存储中的相同 ID 不能证明连接了桌面正在使用的同一后台。
- MCP Events 官方当前列出 Work web、桌面 Work+Cloud、dots；不能用它宣称已实现本地 Codex 聊天唤醒。
- 本项目不需要另申请 OpenAI API key；优先复用现有 Codex 后端的登录和权限。不要读取、复制或输出登录凭据。

官方来源（实施时仍需与本机版本生成的 schema 对照）：

- App Server 与 thread/turn 生命周期：https://learn.chatgpt.com/docs/app-server
- CLI 与 app-server/remote 能力：https://learn.chatgpt.com/docs/cli/reference
- MCP Events 的适用产品范围：https://developers.openai.com/plugins/build/mcp-events

未知项：现有 Windows 桌面后台是否提供可用的第三方连接端点；第二连接是否能安全控制已加载的同一线程；桌面界面是否收到来自第二连接的消息与回合更新。这三个未知项决定能否交付完整功能。

## 3. 选定的架构与约束

链路：DSH 发消息工具 → 本机持久化 outbox → 已授权的目标绑定 → Codex Desktop 接收适配器 → 当前后台的指定线程 → 回合事件与回复 → 发件状态查询。

将“可靠消息队列”与“桌面接入适配器”分开，保持两个职责清楚。首选适配器只连接已存在、能证明属于目标桌面的后台。默认不启动任何第二份 app-server，不使用 exec resume 同 ID 来冒充桌面投递。

公开、可证的宿主投递接口或现有 app-server 连接均可成为适配器，但必须给出接口来源、端点归属、权限边界和真实桌面验收。不得使用私有 IPC 猜测、改写应用安装文件、直接写会话存储、模拟键盘点击或跳过鉴权来凑通路。

应用不支持附着时，明确返回 desktop-attachment-unavailable / platform-unsupported，并保留待发消息。可以提供用户主动读取的 inbox 模式；该模式显示“需要主动接收”，不得显示“自动唤醒可用”。

## 4. M0：先验证桌面接入（阻塞后续自动唤醒的前置门槛）

产出：docs/codex-desktop-attachment-evidence.md 与一个只读 capabilities/doctor 探针。

步骤：

1. 使用现场实际的桌面 bundled CLI 查看帮助，必要时把协议 schema 生成到隔离临时目录；不修改全局默认 CLI、不自动升级。
2. 查明可用端点及其实际所有者。记录平台、二进制版本、端点传输、PID 归属，避免记录令牌或用户聊天正文。
3. 只连接已运行的目标后台，执行 initialize/initialized、thread/loaded/list 与 thread/read。目标必须在同一后台已加载，不能只在磁盘历史中命中。
4. 如果某方法本机 schema 没有，记录确切不支持的能力，不凭最新网页猜一个方法。
5. 在任何写入前，证明此连接能观察目标当前状态和后续回合事件，并确认不会竞争第二个执行器。
6. 在用户已授权的目标线程空闲后，进行一条无副作用、唯一标记的 canary。只要求 Codex 原样回显，不改代码、配置或发布任何东西。验收要能在同一桌面聊天中看到消息与回复，记录 threadId、turnId、marker 和确认方式。
7. 本次根代理仍在规划时不打断它；canary 等目标空闲后投递。

M0 通过：同一后台、同一目标、桌面可见消息和回复均有证据。
M0 未通过：记录精确限制及尝试证据；继续完成可独立验证的消息队列/能力报告，停止宣称桌面自动唤醒完成。不要自动开启远程控制、重启 Codex/DSH、修改权限模式或换到另一条聊天。

## 5. M1：目标绑定与收发契约

名称按仓库现有风格统一；建议新增以下三个 DSH 侧入口，保持 dsh_collab_send 的语义不变：

- dsh_codex_targets：只读列出已授权绑定的目标和接入能力。
- dsh_codex_send：向 bindingId 对应的 Codex 聊天发送 text，返回 messageId 和状态。
- dsh_codex_status：按 messageId 查询投递、运行与结果。

Codex 侧提供绑定与解除工具，例如 dsh_codex_bind / dsh_codex_unbind。由 Codex 侧明确提供目标 threadId 和用户授权的 DSH sourceSessionId，校验宿主/线程身份；不按标题猜目标，也不从最近使用记录选一条默认投递。

最小绑定信息：bindingId、Codex threadId、宿主实例/端点标识、授权的 DSH sourceSessionId、能力、创建/更新状态。端点失效或宿主变化后重新验证，不向旧端点盲投。若当前工具执行上下文不能验证来源会话身份，要标明该限制，不能把调用者自己填写的 sessionId 当成已验证身份。

最小发送信息：bindingId、messageId/idempotencyKey、sourceSessionId、text、createdAt、deliver=queue。生产默认 queue；steer 仅在用户明确授权打断这一目标时启用。未绑定、目标不存在、已归档、权限不足均给稳定的失败原因，不能静默新建目标。

根代理本次明确授权：把这个功能交给“dsh-codex-collab 项目”已有对话实现，以及在本次指定 Codex 目标空闲时发送一条无副作用的验证消息。不要向其他聊天测试或广播。

## 6. M2：可靠消息队列与接收适配器

先复用仓库已有工具/存储方式；可以使用 Node 标准库文件存储，不预先添加依赖。若确需新的依赖，先写清必要性和可替代方案，避免架构膨胀。

- 每个绑定只有一个投递消费者，按序处理。
- 写盘成功后才返回 queued；启动对应回合并获得协议确认后才返回 running；观察到关联回合 completed 才返回 done。
- 回合 failed、目标阻塞、超时和连接中断分别报告，不把 JSON-RPC 接收成功当成任务执行成功。
- 发起请求后连接断开、无法确认服务端是否接受时，返回 delivery-unknown；先查历史/关联回合恢复，不能盲目重试导致重复执行。
- 同一绑定下相同 idempotencyKey 的重复发送返回原 messageId/结果；消息正文改变时明确冲突。
- 主机重启时恢复待发队列；对正在运行或未知投递状态重新核对，不假设未投递。
- 收件内容作为带来源标签的数据/请求传给 Codex，保留原线程的权限、模型和项目配置；不把 DSH 文本提升为 system/developer 指令。
- 回复默认只更新该 messageId 的结果，不自动把回复再次当新消息发回。带 origin 与关联 ID，限制自动往返，避免循环。
- 本机写入口与绑定授权做最小必要鉴权；敏感值仅留本地配置，日志、计划、源码和汇报均不输出令牌。保持既有网关对外范围不扩大。

忙时实现：从真实线程状态/事件判断是否空闲；busy 则持久排队，完成后依次启动。不能通过轮询磁盘文件推断当前活跃回合，也不能调用 interrupt 来腾位置。

适配器输出至少包括 available、deliveryMode、canWakeIdle、canObserveTurns 和 reason，清楚区分自动唤醒、在线长等待、用户主动收件三种能力。

## 7. M3：针对本项目的验证与回归

编写真正验证行为的测试，不用测试恒真 mock 来替代 M0。

- 未绑定、错误/失效目标：失败且不创建线程。
- DSH 来源不符合绑定：拒绝；只读列目标不暴露其他聊天正文。
- 同一消息重复发送：只出现一个回合；不同正文但同 key：冲突。
- busy 期间入队、恢复空闲后按序投递；默认不 steer/interrupt。
- 连接断开、投递未知、进程重启后恢复：不丢消息、不盲重发。
- 对应回合 done/failed/blocked 与发件状态正确关联。
- 自动往返不会形成反馈循环。
- 原有 worker/session 分发、只读会话查找、独立评审与六工具契约不回归。
- 新工具修改后同步 README、MCP 工具清单断言与打包文件清单；版本号三处保持一致。
- Windows 上进行真实桌面 canary；Linux CI 对消息队列/协议适配的纯测试、打包安装做验证，不能用 Linux 的通过替代 Windows 桌面验收。

真实验收案例：DSH 发一条 DSH_TO_CODEX_<随机值>，绑定的原聊天收到并原样回复；记录对应 ID，确认没有新增线程，发件结果为 done。能力不满足则标记 blocked，并附上已完成部分与剩余限制。

## 8. 建议的文件边界与执行顺序

按已有仓库布局调整，不机械新增所有文件：

- docs/：本计划、M0 接入证据、最终使用与验收说明。
- harness/：新增 DSH 发件工具和绑定/队列服务接入；已有 dsh-bridge 的接口语义保持。
- mcp/：Codex 侧绑定/收件能力，以及与真实宿主接入的协议适配。队列和接入模块可按职责拆成少量文件。
- test/：消息队列、目标授权、真实路由契约、busy/重连/幂等回归。
- cordis.patch.yml、package.json、README、CI：仅在对应能力确实实现后更新。

顺序：M0 证据 → 可用性结论 → M1 契约/绑定 → M2 队列与适配 → M3 回归/真实桌面验收 → 可审查 diff 与汇报。保持每一步能单独验证；接入不成立时不要为不可用的唤醒通道搭大框架。

## 9. 执行约束与汇报

在原 DSH 项目对话中继续，使用它已有的上下文、模型和工作目录。实际仓库必须是 E:/11-Github/dsh-codex-collab，发现既有改动时保留，不回滚他人文件。不要新建 DSH worker、工作区或另一条会话来代替。

默认继续执行已授权的本地实现与测试，不等根代理再次确认常规步骤。不要打 tag、npm publish、修改上游仓库、强制推送或擅自扩大权限。先保留可审查的 diff 与证据，不自动发布本功能。

回报必须包含：M0 结论和证据、所选接入机制、改动文件、测试命令与结果、真实 canary 是否进入指定桌面聊天、没有新增线程的证据、剩余限制。如果只能提供收件箱，明确写“收件箱已完成；桌面自动唤醒尚未完成”，不要笼统写功能已完成。

