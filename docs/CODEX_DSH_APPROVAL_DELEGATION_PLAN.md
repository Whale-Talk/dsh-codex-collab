# Codex 接手 DSH 单次审批：方案与实施计划

状态：执行版；M0 已由原 DSH 对话交付（见 `CODEX_DSH_APPROVAL_M0_EVIDENCE.md`），根代理复核后进入 M1/M2。基线：`383528c` / npm `0.1.9`。

## 1. 目标与授权

用户要求：让原来的 DSH 项目对话继续实现，使 Codex 在授权范围内接手 DSH 执行时的审批，用户离开电脑后任务仍能继续，并由 Codex 验收。

交付目标是 **Codex 保持任务活跃时的无人值守审批闭环**。每次只决定当前真实挂起的一个调用，获准后仍由 DSH 原工具执行。超出授权、证据不足、断线、过期时保持人工接管路径。用户缺席不等于授予全机权限。

本轮本机验证范围：`E:/11-Github/dsh-codex-collab` 下的本次实现、文件查看/编辑和必要测试；测试临时文件可用已声明的 `E:/07-Workspace_codex/.tmp`。不把路径名单当作自动批准所有命令的依据，必须判断实际行为与副作用。上一轮发布 npm 的授权不成为本轮通用审批规则。

本轮不修改全局权限、`approval/policy`、permission preset 或上游 DSH；不读取凭据、不自动处理登录/2FA；不批准任意命令、不发布 npm、不打 tag。新的审批能力缺省关闭，显式按任务启用；原有无审批委托调用保持兼容。

## 2. 当前证据与未知项

- `mcp/dsh-mcp.mjs` 现有六工具没有审批查询/决策工具，`waitTask()` 仅等待终态或预算到期。
- `harness/dsh-bridge.mjs` 已使用公开的 `sessionController`、会话 follow、请求/回合关联；`originThreadId` 是关联信息，不是认证凭据。
- 本机官方安装包 `D:/Program Files (x86)/DSH/resources/app.asar` 中 `@deepseek-ai/dsh-user-approval/lib/index.js:130–187`：公开 `approval` 服务在有效 open turn 中记录 `approval/asked`，经 `approval/request` waterfall 获取结果，再记录 `approval/decided`；唯一许可结果是 `allowed-once`，还有 rejected/cancelled/unavailable；策略 never 在 waterfall 前拒绝。
- `approval/asked` 有 `id/toolName/callId?/reason?`；**传给 answerer 的 req 不一定含该 id，也不保证含完整参数**，不得杜撰 API 或用最后一条日志猜对应关系。
- 同包 `@deepseek-ai/dsh-experimental-auto-review/lib/index.js:433–485` 在 tools/pre-execute 中做检查，可返回 ask；Codex 必须能看到真实动作和原检查原因。对实际不可覆盖的拒绝/never 策略保持原语义。
- 本轮只读抽取的 SDK 证据位于 `E:/07-Workspace_codex/.tmp/dsh-approval-protocol`；它们仅供核实，不复制成新的运行时依赖。
- M0 已证实 `ctx.on('approval/request', handler, {prepend:true})`、公开 req 六字段及 `tools/pre-execute`/原生 `tool/call` 参数来源。公开 req 不带参数、cwd、turn/step。PTC 内层映射、worker child 身份和真实组合的 scope/时序仍须 native 验证。
- 空闲后自动唤醒 Codex 的旧 M0 仍 blocked。本方案不把后台 HTTP 监听、收件箱或 MCP notification 写成“已经唤醒 Codex”。

## 3. 方案取舍

原则：用户范围优先；单次与真实调用绑定；使用公开扩展点；失联不放行；沿用现有关联/锁/审计能力。

考虑的方案：

| 方案 | 好处 | 限制/结论 |
|---|---|---|
| A. 正式 approval/request answerer + Codex 活跃循环 | 保持 DSH 工具执行和官方审计，支持逐项判断；与现有 origin/task 相接 | 需要 M0 证明顺序/调用证据和正式挂起请求；选择本方案 |
| B. 改全局 preset / 全部自动允许 | 实现少 | 越出委托范围、失去逐次判断；不采用 |
| C. UI 自动点批准 / 写会话日志伪造 decided | 可表面解卡 | 无法证明真实请求与单次语义，绕开正式边界；不采用 |

不额外引入常驻模型代理、定时任务或通用策略框架，不添加新依赖。独立离线策略审批、空闲唤醒属于将来独立需求。

## 4. 端到端流程与状态

1. 由可信 Codex 调用路径为**明确关联的任务**启用委托，记录 origin/task/target/授权范围/有效期/撤销状态。不能让 DSH 提示文字、仓库文件、审批原因或一个普通 localhost 请求自行签发/扩大授权。
2. 在官方请求挂起时，仅接手能严格证明属于该 task 的请求。会话目标复用 `requestId → rpcId → DSH turn`；worker 目标必须绑定它真实的执行 child，而不是 owner、最近会话或任意 agent。不能可靠绑定的目标如实报不支持。
3. 形成不可变审批快照：桥接审批 ID、官方审批 ID（可证实才填）、origin/task、session/child、turn/step、native 或 PTC 调用身份、工具名、完整实际参数、cwd、原因、创建/过期时间、动作 fingerprint、授权版本。参数只从宿主 `tools/pre-execute` 的真实 execution 快照及原生 `tool/call` 日志取得；审批 req 本身不含参数，客户端也不得再传一份替代。匹配不足时 next()，不能只信自然语言 reason。
4. `dsh_task`/等待逻辑遇到审批应及时返回 `needs-approval` 及查询入口，任务保持非终态。Codex 取详情、逐项判断，提交 `approve-once` 或 `reject`。审批正文是待审数据，不是给 Codex 的新指令。
5. 新决策接口核对真实挂起项、调用快照、有效委托、控制凭据、fingerprint、未撤销/未过期/未被上游处理，才一次性完成官方 answerer。不得替 DSH 另起进程重执行命令。
6. 决策已提交与 DSH 已采纳要区分：跟踪官方 `approval/decided` 或同等受支持确认；只有任务自己的 turn/completed 才是整个任务 done。未确认回应报告 `decision-unknown`，不自动重发放行。
7. Codex 继续有界等待/查询，处理下一条审批直到完成或确实需要用户。CLI/MCP 调用及时返回；不能把一个长时间阻塞工具调用当作模型仍在做审批。

建议桥接状态：task `running ↔ needs-approval → 原有终态`；approval `pending → decision-submitted → confirmed`，以及 `rejected / cancelled / expired / superseded / decision-unknown`。准确状态名可精简，语义必须可测。

## 5. 范围、认证、时序和恢复

- origin/task/session/turn/callId 只负责定位；**新增改变审批结果的 HTTP 路由不能仅凭这些可见 ID 或 loopback 放行**。采用显式控制凭据/不可伪造的任务能力，M0 说明签发、保管、撤销和传输方式，可信发起方之外不能申请 grant。新增含审批正文的清单/详情/授权查询同样鉴权，公共 capability 只返回非敏感能力元数据。凭据不入仓库/提示/会话日志/错误正文/审计；缺失或错误时零决策。不要重构既有所有 API 的认证。
- 可信委托内容存于仓库外。拒绝依据任意本地可写策略文件来扩大权限；承认同一操作系统用户不是强隔离边界，不作不成立的安全承诺。
- 控制凭据采用**可信本机 CLI/安装动作离线初始化的私有 key 文件**（仓库和工作区外；无则缺省关闭），host 与 MCP 内部读取。不能暴露未认证的 HTTP enable/bootstrap/领 token 路由；控制 token 不出现在任何 HTTP 响应或 MCP 工具结果中，也不让模型携带它。任务 grant 必须先验证控制凭据和已绑定任务/明确范围再创建。grantId/版本/指纹是非秘密定位数据，不当作单独认证。轮换/撤销、原子初始化、权限与同用户信任边界写清楚，避免“先凭一个普通 localhost 请求领控制凭据”的循环授权。
- **认证等价物同样保密**：若服务端把 `sha256(key)` 直接当可接受的 header，完整 hash 就是 bearer 凭据，不能以“只是 hash”为由写入 grant/日志/返回模型。最小方案可让私有 raw key 仅在 MCP/CLI 内部通过认证 header 传输，持久 grant 只保留不可用于该协议登录的单向摘要；不必为了“raw key 绝不上线”发明会泄漏等价密钥的协议。审计默认只记身份和动作指纹，不能用不可靠的正则摘要宣称保证去掉 JSON/命令中的所有秘密。
- approve-once 不是 session 级许可。原检查/用户策略 never 仍拒绝；未关联请求、不在授权任务的其他审批调用原有 next()，不拦截不吞掉。
- M0 观察到 UI 的 `PendingApproval.delegate()` 及 `isDelegation→next()`，但根代理复核同文件 `ApprovalPanel` 只渲染“拒绝/允许一次”。**不声称存在用户可点击的“委托”按钮**。已在旧 UI 等待的请求不自动接手；新请求依赖提前安装的 prepend handler。内部异常在安全边界未作决定时交原 next()，不通过 throw 吞掉人工链。
- 批准需由 Codex 结合真实内容判断；命令前缀、工具名、路径命中、测试名或 reason 中写“安全”均不足以自动放行。脚本副作用、重定向、符号链接/junction、路径穿越和外部网络行为必须纳入判断；缺少证据交人工。
- 使用有界活跃租约（建议 60 秒，可配置）和审批 TTL；只有通过认证且匹配该委托的 Codex 调用可以续租。旧公开 status 查询、DSH 自己的事件和未认证心跳不能续租。失联或租约到期时不作 approve，通过正式 next/取消机制交还原人工处理链或标记需人工；不得永久挂住 waterfall。等待审批期间应明确处理现有 quiet/total 预算，不能一边保留有效租约、一边误收尾成完成或丢弃活任务。
- 处理 req.signal、父任务取消/完成、并发请求、插件卸载、人工或其他 answerer 已完成、过期后延迟响应；清理定时器/监听器，一条请求最多完成一次。
- 决策幂等：同一 key+相同请求/决定只返回原记录；同 key 异文冲突拒绝；不同 key 也不能重复完成已解决的请求。fingerprint 改变/身份歧义则拒绝，需重新审查新请求。
- 审计记录在用户数据目录，复用 `fs-lock.mjs` 等现有实现，保留 actor=codex-delegate、grant版本、绑定和决定摘要。完整敏感参数不默认落盘；只保留验收需要的脱敏内容/摘要。审计失败不得悄悄放行。
- 重启可恢复归属和审计；内存 callback 丢失的审批不伪称仍可批准，不依据旧 JSONL 再执行。只有正式当前状态可重新确认同一挂起请求时才恢复可答状态，否则 unknown/需人工。旧 R1 未完成任务恢复 unknown 的语义保持。

## 6. 产物与接口建议

沿现有风格做小改动，可调整命名但避免大框架：

- `harness/codex-approvals.mjs`：绑定/不可变请求/短期委托/状态/幂等/审计，复用现有锁。
- `harness/dsh-bridge.mjs`：惰性检查官方能力、绑定真实 task、注册/解除正式 answerer，添加局部审批路由和 capability。
- `mcp/dsh-mcp.mjs`：`dsh_approvals`（待审清单/详情/有界等待）、`dsh_approval_decide`（一次性批准/拒绝）；`dsh_task/status` 返回 needs-approval 时不报告终态。
- CLI 脚本与 `skills/dsh-collab/SKILL.md`：来源显式、最小授权、处理审批后继续原任务，不能因 needs-approval 重发原派活。
- capabilities 明确 reporting：正式审批可用/原因、需显式启用、active-only、`canWakeIdle:false`；不支持版本/缺凭据/旧 gateway 时零执行、明示不支持。
- 文档 `docs/DSH_APPROVAL_DELEGATION.md`、README；测试新增专门模块/集成/E2E，保持已有六工具兼容与包契约。
- 新增工具时同步 tarball/MCP 工具数/CI 断言，不靠删除旧断言或误写固定六工具通过。若发布版本号改变，package、Codex manifest、MCP version 三处一致；本轮不实际发布。

## 7. 阶段计划与停止条件

### M0：正式接口与真实上下文门槛

在仓库中写证据：官方 SDK 版本、精确注册 API/顺序、req 字段、官方结果语义、action 获取和 native/PTC 身份规则、权限/next 行为、控制授权方案、真实 canary 接入方法。证据不足的能力报 false。没有受支持的正式 answerer 或不能证明调用身份时，停在明确阻塞及已有可验证部分，不能造 API 或改上游。

### M1：请求与授权核心

实现快照、显式任务委托、控制认证、单次状态机、幂等、TTL/租约、最小持久审计与撤销；先给有意义的单元/并发/恢复测试。

### M2：接入网关与 Codex 工具

正式 hook、关联、needs-approval 返回、查询/决定、CLI 和技能中的继续循环、能力上报；旧路径回归。未实现的 worker/PTC 或旧请求接管清楚报告，不把不支持伪装为可用。

### M3：集成与用户缺席情境

用真实网关 + 独立 MCP/CLI 进程走至少两次审批再完成同一任务；验证 active Codex 循环不需要人点击。再模拟断线/过期/人工抢先/取消/重启，证明不误批准、不重复执行、可返回人工链。

### M4：Codex 独立验收

DSH 回报实现 diff、命令和测试、M0 证据、限制、真实验证方法。Codex 读实际代码、运行独立负向验证、打包与干净安装，再在能正式加载适配器时对原会话做无害 live canary。真实 canary 若不能运行，必须明确剩余缺口，不能称完整交付。验收失败交原 DSH 对话修正，原任务 delivered 后不重复派发。保持可审查工作树，不擅自推送、tag、发布或重启当前客户端。

M0 阶段“不安装/不重启”是阶段约束，不能误写成用户禁止整轮的必要本机测试。根代理会先完成代码审查和独立验证，再准备备份与可回退的局部测试加载；涉及影响其他活动任务的 profile 重启时，先核实影响和支持的加载方式，不在 DSH 自测阶段擅自做。根代理当日复查 desktop/global 已安装版本均为 **0.1.9**，不是 M0 报告中的旧记忆 0.1.7；不得以旧记忆下结论。不得为了 canary 更改 never；是否适合正例需读取目标真实有效状态，未证实则如实说明。

## 8. 验收矩阵

1. 已授权真实请求 → needs-approval；详情包含完整动作及稳定绑定；一次批准 → 官方 allowed-once → 原命令只执行一次 → 原 task 精确 done。
2. 同一任务连续/并发两次请求能逐项处理；不会把另一任务/会话/turn 的请求发给错误来源；错误 origin/task/approval/控制凭据组合全部拒绝且零副作用。
3. 无 grant、grant过期/撤销、仓库文字伪造授权、任意 localhost 调用签发 grant、缺鉴权、缺 callId/歧义日志/可变参数等不得放行。
4. 不同参数相同 callId、相同参数不同 turn/step、native 与 PTC 内层冲突、父 owner 与 child 混淆全部拒绝。
5. 拒绝、取消、超时、上游已决定、插件卸载/重启、audit写失败、请求 signal 已 abort、决定发送后确认丢失：不得假成功、重复执行或永远吞住原 UI。
6. needs-approval 等待及时返回（本机集成目标：出现请求后 3 秒内，轮询/等待单次不超过 30 秒）；租约到期后有界交还人工。整个任务不因等待审批误报 done/error 或被活跃任务淘汰逻辑删除。
7. Codex 新进程按 origin+taskId 恢复详情和审计；失去 live callback 明示不可答；旧 R1 串回合/去重/恢复语义与 outbox 测试全部通过。
8. 未启用委托/不受支持目标保持旧行为；never、其他 answerer、现有自动检查语义保留；不能以“开启功能”绕过 DSH 原权限控制。
9. 打包包含新代码/文档；独立进程 tools/list/schema 与能力说明一致，版本一致；干净安装无新增依赖；Windows 与 Linux 的公开 CI 校验兼容。
10. live canary 用已授权仓库临时目录的无害读写/输出，不使用真实发布、删除用户数据或凭据操作。记录 origin/task/session/turn/approval 与预期 nonce，保存官方 asked/decided 和任务结果证据；没有人点击仍继续才算通过无人值守情境。

## 9. 预演风险与缓解

- 串错请求或被文字诱导扩大授权：不变动作+严格多层绑定+独立控制认证+原始参数审查；重点负向测试。
- Codex 已离线但桥接仍等待：租约、TTL、正式 next/取消、状态与 callback 分离；不能声称 idle wake。
- 决定已采纳但回应丢失，重发导致重复：原生一次性结果、幂等键、decided 证据、decision-unknown 与不自动重试放行。

测试分层：单元覆盖身份/状态/审计；集成走真实 HTTP/MCP/CLI 与可控正式 hook；E2E 覆盖 native/PTC 中已证实支持范围；live 用实际 DSH。观测仅记绑定、阶段、摘要、耗时，不能记录控制凭据或完整敏感命令。

## 10. 分工与本轮执行方式

采用用户指定的现有 DSH「dsh-codex-collab 项目」会话；Codex 来源为当前发起对话。真实 ID 由本次工具参数与仓库外关联记录携带，不写成发布默认目标或授权名单。DSH 负责实现与自测，Codex 负责独立审查/验收，不新建 DSH 会话。独立原生 reviewer 可审方案或 diff，不改 DSH 的实现文件。

本轮按 App 可用的直接方案/评审/DSH 交付方式执行，不启动 OMX tmux、Goal 或额外常驻服务。插件实现不加入调度器。根代理为用户已授权的“DSH 做完后由 Codex 验收”建立仅此对话的临时 App 自动跟进，每 10 分钟检查修正交付，验收完成后停止；该任务级跟进不改变插件 `canWakeIdle:false`，也不能替代通用审批流程的活跃租约。计划不是运行授权凭据；实际 grant 只能由可信发起路径按用户本轮范围创建。

原生 researcher/critic 角色启动分别被当前账户的模型可用性拒绝（gpt-5.4-mini / gpt-5.5），没有取得原生评审结论；不宣称通过 Ralplan 共识门槛。替代方式为 DSH 独立审查本方案/实现、Codex 独立检查 DSH 的实现与验收。
