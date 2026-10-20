# DSH 插件动态模型选择与有界故障切换

状态：已获用户授权的实施计划。2026-10-16，用户要求读取其已配置模型、优先 DeepSeek、按任务选择，模型失效时自行切换；并明确选择“已有普通对话中的插件任务也启用”。原 DSH 项目对话实施，Root 独立验收。

## 目标与范围

覆盖插件管理的编码/评审子代理，以及明确来源绑定的普通会话 queue 任务。queue 各自拥有模型策略；steer 回执沿用父任务策略，不另建策略、审批或结果。人工后续回合、其他任务、其他 session、全局默认模型/preset 不被接管。保存原有182项审批/投递回归与本地README修改。

模型候选只能来自用户当前运行时已注册 provider 的目录，provider/model 组合是唯一身份。优先选择兼容的 DeepSeek，再用其它已配置兼容模型；没有 DeepSeek 时仍可工作。允许用户明确选择模型或关闭本任务故障切换。不读、复制或展示密钥/登录配置，不添加 provider、凭据、模型套餐或依赖。

冻结基线：`E:/07-Workspace_codex/.tmp/dsh-codex-install/model-routing-baseline-ygW13z/baseline.json`（51文件，HEAD383528c，前182项已验收，均未提交）。任何恢复都不能直接拿HEAD覆盖该基线。

## 已核实的官方接口与限制

以本机官方 `D:/Program Files (x86)/DSH/resources/app.asar` SDK0.2.0-rc.2为准。Root只读笔记：`E:/07-Workspace_codex/.tmp/dsh-codex-install/model-routing-sdk-notes.md`。

- `llm.listProviders()` + `listModels(provider)` 枚举实际注册路由与其模型；`resolveModelInfo/resolveCallConfig` 提供能力/effort检查。不存在getModelsList。目录/能力解析成功不等于凭据、额度或远端健康已验证。
- 元数据不提供质量/速度/价格评分。`toolUpdate`表示工具历史投影规则，不可当作“支持工具调用”的布尔字段。未知能力诚实标未知；任务适配按真实模态、context、effort及可解释偏好，不制造SDK评分。
- `agent/request` 每个attempt都执行，能够按任务覆盖本次请求的provider/model。`agent/request-error`仅对结构化模型请求失败决定同turn/step retry。失败attempt的工具尚未执行，前序step工具保留，不能重派prompt、另建child、cancel/resume整任务或从头跑工具来冒充故障恢复。
- 首次request发生在user/message写入前，不能只凭事后日志rpc绑定。官方 `agent/inbox/claimed` 提供真实agent/message/turn，需在派prompt之前监听，并用已登记queue requestId严格认领首次请求。回执不成为owner；worker亦须在首次请求之前绑定可信child/owner身份。
- `sessionController.selectModel`会触发全局default保存，而且retry不重新assemble；不得用它作为本次任务无副作用切换，也不得写readonly options或配置。
- 实际route覆盖会写官方request/header；后续请求proposal/缺省selection可能继承该header。所以完成时仅删map/卸hook仍会泄漏fallback模型到人工下一回合。须保留用户选择意图并通过受支持的请求层/选择投影做条件恢复；期间人类明确新选模型必须优先，不调用selectModel/saveSelection。此项必须真实SDK验证，不能以mock options没变代替。
- prepareCall部分异常在request-error之外；必须在请求阶段预检，有准备期竞态无法恢复时明确报告边界，不能通过重派任务掩饰。
- 原生retry策略有normal与always。自己的路由耗尽不能交给always继续无限重试；需实际验证listener顺序、单模型次数、模型数与总时限，以及abort/unload。

## 对外契约

1. 默认 `model:auto`（未指定的新插件任务同样auto）；`fast/pro`兼容为偏好，摆脱固定DeepSeek型号。保留显式 `default` 继承当前选择的兼容意图。支持精确 `provider` + `model`，未给provider但存在同名模型歧义时明确拒绝并给候选，不静默选错。
2. `modelFallback` 可显式关闭。默认auto/fast/pro开启；精确指定模型默认固定，调用方显式开启才允许故障降级。所有选择仍须在已配置目录和任务能力约束内。
3. 新增只读 `GET /api/dsh-bridge/models`、MCP `dsh_models`、CLI `--models`，提供候选pair、受支持能力/未知项、选择理由、已知临时失效及有效时间；不显示凭据、认证URL、endpoint正文。工具数由8变9是本次有意变更，CI握手与文档同步。
4. 任务派活/查询回显实际选择、选择模式、失败/切换次数与限制。提供 `capabilities.modelRouting`（真实scope、版本、发现/首请求/运行中恢复能力）；新客户端使用新参数前只读预检，旧网关不得忽略新字段后照常执行。旧调用维持清楚的兼容行为，普通无来源session仍不获得跨任务自动控制。
5. 模型选择/切换仅覆盖本任务发出的请求配置，不持久修改会话手选模型。source/task/session/parent绑定、唯一审批owner、never、队列FIFO与取消保护不变。已有会话首次请求、后继步骤、同回合重试、下一队列任务、人工下一回合均须分开验证。

## 选择、失败与恢复

- 在任务开始取新鲜配置快照。provider目录失败隔离；有界缓存/拓扑更新失效，不能永久缓存null。不为了“健康检测”额外付费请求所有模型。
- 策略先满足输入模态、上下文/输出预算、effort兼容性和用户显式选择，再按DeepSeek偏好、任务类型与可解释的fast/pro等名称提示排序。不能把提示当质量或价格保证；保留adapter自身顺序作为稳定回退。
- 路由必须同时传provider/model，不能沿用当前provider却只替换model名。跨模型时不得带入不支持的effort/maxTokens，不得删图片、丢历史或重复工具来凑兼容。
- 用官方结构化failure.code/status分类。认证/凭据缺失、额度、确定模型失效等可直接选下一兼容候选；限流/服务端/传输/超时按有界策略并尊重retry-after。拒答/安全拦截、用户取消、审批拒绝、工具错误、未知插件异常不靠切模型绕过。HTTP404只说明路由不可用，不能断言一定是模型下架。
- 默认最多3个不同候选（含首次），每个候选/整个任务恢复有次数和时间上限；不绕圈重选已失败候选。临时失败可有有界冷却，仅影响相应pair/实际失败provider，不能永久封禁所有模型或跨profile污染。
- 相同taskId、原source RPC、同session、同turn/step重试。保留历史与已完成工具结果；失败流的部分tool-call不执行/不拼成成功消息。备选耗尽如实error/明确原因，不能done加空输出，也不能以观察unknown当模型故障触发重发。
- 编码子代理的模型切换不清childId或另起child冒充继续；复用/冷恢复也必须证明首次请求绑定。原有cold-resume的one-shot兜底不能拿来处理模型故障或不确定的已接受任务。
- 生命周期在完成/错误/取消/卸载时准确收口。已在途异步返回不得复活策略；重启只恢复审计事实，不重派任务或假恢复执行。

## 日志与回溯

本任务范围内补结构化模型路由审计（独立JSONL或现有关联记录的最小扩展），字段包括时间、origin/task/session/父关系、turn/step、旧/新provider+model、选择理由/稳定错误码、序号、冷却与耗尽结果。任务查询及重启后可检索非秘密的最后选择/切换摘要。原始failure.message、prompt、工具参数、key、认证URL不得作为模型路由日志输出。不得只console打印便宣称跨重启可回溯。不给已完成审批记录增加原始命令内容。

## 实施阶段与交付

M0：原DSH核验上述接口，尤其首request归属、worker首请求预绑定、原生retry层顺序，并写 `docs/DSH_MODEL_ROUTING_M0_EVIDENCE.md`。用真实SDK组件及可控离线adapter证明可行，不冒充远端模型在线健康测试。证据支持即继续，不等人工确认；若无法满足安全恢复/精确归属则反馈具体缺口，不搭大框架。

M1：最小路由决策/目录模块，保留可解释排序与有界健康状态。

M2：真实宿主hook与worker/session/queue/receipt接线、MCP/CLI/HTTP模型发现/输入/响应/能力预检、持久日志；同步README/SKILL/开发文档与CI9工具契约。不碰Rootcanonical计划。

M3：自测交付真实diff、完整回归、接口/负例与离线官方SDK组件证明。所有模型故障测试用隔离假adapter，不拿用户付费模型逐个探活，不读登录凭据。

M4：Root独立审查和反例、完整回归、打包/干净安装；仅在新建的独立临时官方DSH profile挂最终包，用有结构化失败的本地测试adapter验证模型切换与唯一nonce效果，确认真实AgentLoop/日志；若必要单次真实已配置模型冒烟，先保证隔离且严格有界，不重启现有客户端。验证后停自建进程，核验绝对路径后清理自建profile/key，保留证据。最终才报告通过。

## 验收矩阵

- 多provider/同名模型/只有非DeepSeek/DeepSeek不可用/目录返回空或部分失败/配置变更/缓存过期；目录列出但不可调用不误报健康。
- auto/fast/pro/default/精确pair/禁fallback；meta未知、模态/effort/context不兼容；编码/评审的选择依据如实可读。
- 首request实际使用所选pair，先执行一个nonce工具后下一step模型失败，原turn/step内换模型恢复，nonce恰好1次；失败attempt流出的tool-call delta不执行。
- 已有普通session中A运行/B排队/S补充，各自策略准确；S沿父；A故障不改B策略，A收口不清B策略/审批；人工后继回合和另一并发session不被接管，全局default保存次数0。
- 可恢复与不可恢复错误区分、信号取消、所有候选失败、SDK always重试、生命周期卸载以及准备期竞态均有界，任务不误报done、不重派prompt、不丢原历史。
- CLI/MCP真进程+真HTTP：目录、策略输入、旧网关预检零执行、来源严格回显、重启回溯model审计；原审批和queue/steer182项保护继续通过。
- 最终pack含新模块/文档；9工具握手/版本号一致；最终包真实SDK测试profile的request/header pair变化、原RPC/turn关联和nonce文件直接作证，而非只拿测试计数验收。

## 边界

用户追加的交付要求（2026-10-16）：README首页须显式标注fork自 `FuJackGao/dsh-collab` 并链接上游；保留“项目来源与鸣谢”章节，感谢FuJackGao及上游贡献者，清楚区分原项目与Whale-Talk fork的后续扩展。Root已按GitHub实际parent核实并写入README（证据 `E:/07-Workspace_codex/.tmp/dsh-codex-install/readme-upstream-credit.json`）。后续模型功能文档更新不得覆盖这段鸣谢，原LICENSE版权/许可声明保持原样。

生产实现仍由原 `session-dd9655aa-b99f-4e36-b914-a5035fd094e1` 编码，Root独立验收；所有派活/查询显式originThreadId=`01a100f1-045c-7e10-84c7-ac8ec37eff3f`。不新开编码会话，不加依赖，不读复制凭据，不改上游SDK/全局权限/preset/原never，不重启现有客户端，不commit/push/tag/npm发布。已delivered不重发，unknown只读原request官方证据，不猜最近助手。日志通用中心/轮转和普通聊天新建工具不在本次范围。
