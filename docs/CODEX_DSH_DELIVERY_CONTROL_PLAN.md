# Codex 决定 DSH 指令排队或插入：方案与实施计划

状态：执行方案。用户明确允许 Codex 按任务关系决定新指令等待当前任务完成，或中途插入；沿用原 DSH 项目对话实施，Codex 独立验收。前一审批功能已通过159项回归及独立真实 DSH profile 验证；它是本次必须保留的未提交基线。

## 目标与用户行为

- `queue`：新任务先被可靠接收，当前任务完成后再执行；忙不等于错误。每个任务拥有独立 taskId、来源、请求回合和结果。
- `steer`：补充或纠正当前任务，在 DSH 官方支持的下一步边界插入。补充拥有唯一回执 ID、父任务和自身输入证据；最终执行结果归父任务，不伪装成独立回答。
- 由 Codex 在工具调用时明确选择模式。默认 queue；用户指定的方式优先。已获本次用户授权后，Codex 可在同一目标/任务范围内选择 steer，不必每次询问。
- `wait` 只控制调用方是否等待返回，与 DSH 指令投递模式分开。不得把“不等待工具响应”当作已经排队，也不得把“插入”解释成取消/杀掉正在执行的工具。

## 当前代码与官方证据

1. 现有 MCP/CLI 已有 queue/steer，但 `dsh-bridge.mjs` 对来源绑定的 steer 直接 `origin-steer-unsupported`，对同会话任何在途任务直接 `session-busy`。
2. `sessionTargets` 以sessionId为键，只能保存一个观察记录；不能直接删除busy检查，否则后来的记录覆盖原任务并破坏审批归属。
3. 当前单request tracker遇到本身rpcId就绑定其所在turn。同turn两个rpcId会共享turn/end及输出，不能声明它们有两个独立结果。Root独立只读子代理还复现了重放缺陷：B首遍AFTER，重读完整日志变AFTER|BEFORE，原因是绑定前忽略的事件未记去重。
4. 本机官方 `@deepseek-ai/dsh-api-session-controller/lib/index.js:850–883`：prompt保留requestId为user source.rpcId；mode steer调用agent.steer，否则followup；接受响应只表示接收。
5. 官方 `dsh-agent-loop/lib/index.js:800–813`：followup写next-turn，steer写next-step；没有在这里cancel/abort正在执行的工具。`claim():103–109` 会取全部next-step，**next-turn每次只取一条**。优先复用官方原生队列，不另建持久消息代理或数据库。
6. 官方prompt内部存在异步resolve/admission，尚未证明提供原子的expected-turn条件。必须处理父回合恰好结束的竞态；不能把帮助里的mode字段当作原子保证。

## 设计约束

### A. 真队列与唯一执行结果归属

- 优先调用已证实的原生queue，每次独立requestId。支持同一session多个来源明确的在途任务，以taskId保存各自观察记录；状态/停止事件只按各自rpcId→turn/end结算。
- 若底层版本不能证明逐条next-turn，则在M0如实报告或用最小串行调度适配，不偷换成同turn多任务共同done。
- 同session的投递接收顺序需可靠；有必要只给短暂prompt admission加锁，不用锁阻塞完整执行，也不全局串行不同session。
- 旧的无来源/不可精确关联模式继续保持保护；不得为新session能力全局移除worker/reviewer桶忙锁。
- “已接受/排队中/正在执行/等待审批/完成/未确认”分开，向Codex及时回显真实状态。队列位置不确定时不猜包含人类输入在内的全局名次。
- 全会话running/idle事件只触发重新观察，不能把所有B/C标成running或done；每个任务开始和结算仍需自身rpcId/turn证据。
- SDK已接受的queued指令网关重启后仍可能执行；沿用unknown+resend:false，不因恢复丢内存而重新投递。

### B. steer作为明确父任务的补充回执

- 继续使用显式 `deliver:'steer'`，增加明确父任务定位（建议parentTaskId，必要时expectedTurn）。父任务必须属于相同origin、profile、session，且有真实当前开放回合证据。不得按“最近任务/最老任务”推断父任务。
- 回执独立taskId/requestId、parentTaskId、requestedMode、receiptState、requestSeq/observedTurn等证据持久化。接收不等于被模型读入，更不等于已执行完成。
- 同父任务支持多次补充，各自rpcId可确认。回执查询指向父任务最终结果，声明resultScope=parent-task或同等语义，不能把父任务完整输出再冒充补充的独立结果。
- steer的wait只等待自身接收/官方观察回执（单次有界，不超过30s），不复用“独立任务等最终结果”的循环；要执行结果时显式查询父task。回执只消费自己的user/message，不累计该共享回合的助手文本。
- 持久化分别保存“回执已观察”与“父执行状态”；重启父task变unknown不抹去回执已观察的事实，已观察回执也不能证明父任务已经done。未观察但SDK已接受仍不重发。
- 若父任务仍排队、已终态、来源错误、回合不明，执行前拒绝且零prompt。跨来源指令不能改变另一来源正在运行的父任务。
- 对父任务刚结束的竞态：若能执行前阻止则拒绝；若官方已经接受但实际落入另一回合，保留真实回执/observedTurn并明确未确认或偏离目标，不宣称插入成功，不静默改模式，不重发。不能要求不存在的SDK原子接口，更不能取消用户回合来制造插入。
- 不支持对不可证明父任务的非托管/冷会话任意插入；明确报不支持。以后可另做有证据的扩展。

### C. 保留已通过的审批隔离

- 多个queued任务共用session后，审批归属只能由**当前真实open turn对应的唯一queue执行任务**确定。steer回执绝不成为审批owner、结果owner或独立lease owner；即使S1/S2与A同turn，也只有A是执行owner。旧代码sessionTargets.get(sessionId)等单记录假设须逐一替换，不能改成任选一条活task。
- 排队后B的grant不能批准正在跑的A；A完成撤销/结算不得清掉B的pending；只关闭对应task的挂起项。
- 收口只删除自己的观察记录；pending同时匹配sessionId/taskId，必要时grantId。回执收口不触碰父pending。需验证A迟到的decided、B新ask和S1已观察交叠仍不串线。
- steer回执不另建、更不扩大父任务grant；原始授权范围仍由Codex按真实动作判断。新的指令文本本身不是新权限。
- 插入不会自动批准/拒绝旧pending，也不改全局never/preset。若工具正等审批，下一步插入可能要等该真实工具结束；状态要准确，不能谎称插入已立即执行。
- 长排队的lease/TTL仍真实有效、由匹配的活跃认证调用维持；过期不自动复活/重新签发。queued状态纳入活任务计数、防淘汰及客户端等待。

### D. 客户端、能力与兼容

- HTTP/MCP/CLI/DSH原生collab工具及项目技能统一契约，保留`--steer`兼容，补显式父任务参数；默认queue。
- 客户端先只读核验新投递能力（不能靠0.1.9版本号猜）。旧网关无法处理新父任务/回执语义时零派活拒绝，不能忽略新字段后继续执行。
- origin/parent/turn只是定位。新增有来源steer会改变现有任务，复用既有离线控制key的内部HTTP鉴权（MCP/CLI自动带头，不让模型传key）；缺凭据零插入。旧的非委托queue保持原行为，无来源legacy路径不能用于绕过新的父任务保护。不要另造领token或通用权限框架。
- 人类给出任务后，Codex选择：独立后续工作或依赖前一结果→queue；同一父任务范围内的纠错/补充→steer。服务器不通过关键词猜急迫程度，不新增常驻模型审批者。
- 继续显式传当前origin；每次响应严格回显，等待/详情/结果不串来源。保存父任务/回执关系和事件证据，异常或断线不自动重发。

## 阶段与产物

1. **D0官方契约证据**：写`docs/DSH_DELIVERY_M0_EVIDENCE.md`，核实原生队列顺序、steer消费时机、父回合竞态、source.rpcId和SDK支持能力。用真实SDK组件做可复现契约测试；不冒充完整Desktop。若证据支持，继续实施，无需等人工确认。
2. **D1状态/存储**：最小改造多任务观察及不可改投的父/回执关系；修复新场景所暴露的回放顺序/去重问题；保留旧R1unknown和精确结果语义。
3. **D2接线**：gateway、MCP、CLI、native工具、技能和使用文档同步；审批选取与task粒度收口正确。
4. **D3自测交付**：按下面矩阵做行为回归，重跑原159项，不以改断言取消隔离边界。原先“所有origin steer拒绝”的断言改为“无有效父/无能力拒绝；有效父按回执协议接受”。保持可审查diff，不提交/推送/发包。
5. **D4Root独立验收**：读相对本次冻结基线的真实差异；独立负例、完整回归、pack/干净安装，再在独立临时真实DSH profile中完成queue与steer正负例。只有最终产物实际通过才验收；回归失败交原对话修。

## 必测矩阵

- A运行中queue B/C：即时接收并可查询、按官方FIFO独立回合执行；各自task/RPC/结果不覆盖，A失败或审批时B不误结算。
- A运行中steer S1/S2：不取消A；官方日志出现各自rpcId且同父turn；父结果唯一，补充回执准确关联，重读/快照/重复事件不乱序或重复。
- 另一origin/profile/session、已结束/排队父任务、错误expectedTurn、未知父任务、旧网关：零投递或在已接收竞态时如实未确认，不偷读别人的结果。
- 既有A审批挂起、B排队且有grant、A被steer：B授权不能决定A；插入不绕过审批；父任务收口不影响B的回调/状态。
- 不同session并行；worker/reviewer忙锁不退化；queued任务不被淘汰。队列项/回执若不能逐请求安全撤回则明确不支持，不能用session cancel撤它或取消父任务。保留原单任务force-cancel；多任务情况下只在能证明不会误取消B/C时允许取消当前A，否则拒绝这个不安全组合。A已结束而B刚运行时不可cancel B来回应旧A的取消请求。
- 接收后确认丢失/网关重启、steer落错回合、客户端断线：持久关系可查，回调不伪恢复，不自动重发，不通过最近助手文本判完成。
- CLI和MCP都实测queue/steer，不只测协议字段/计数。最终真实profile证明A未完成时新queue被接受，steer在同turn被消费，queue在后续turn执行；记录官方事件、唯一nonce和准确结果。

## 执行边界

生产实现由原DSH项目会话负责，Root负责方案与独立验收。先备份当前未提交的159测试审批基线，不能用HEAD恢复覆盖它。只用精确edit/write改UTF-8文本，禁止PowerShell文本管道重编码。不开新编码会话，不加依赖，不读/复制凭据，不改上游SDK，不改全局权限/preset或原never，不重启已有活动客户端，不commit/push/tag/npm发布。必要真机验收仅用独立临时profile，验证后清理自建profile/key，保留证据。自动跟进若用于本次长任务须在验收完成后停止，不能声称插件已能idle wake。
