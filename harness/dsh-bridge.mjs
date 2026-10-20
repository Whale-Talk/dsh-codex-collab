/**
 * dsh-bridge: Codex ↔ DeepSeek Harness 双向协作网关（持久化宿主插件）。
 *
 * 提供：
 *  - POST /api/dsh-bridge/task     派活：target.kind=worker 新建子代理（现有行为），
 *                                  target.kind=session 接进已有会话
 *  - POST /api/dsh-bridge/sessions 只读"找到会话"（search / resolve），不创建任何东西
 *  - POST /api/dsh-bridge/review   双向评审（独立评审子代理，必须跑通构建/测试）
 *  - GET  /api/dsh-bridge/tasks    任务列表
 *  - POST /api/dsh-bridge/cancel   取消任务（session 目标默认拒绝，需 force）
 *  - GET  /api/dsh-bridge/status   任务状态
 *  - GET  /api/dsh-bridge/debug    调试信息
 *  - WS   /api/dsh-bridge/ws       实时推送（升级协议，供可选客户端使用）
 *
 * "找到原对话"与"接通原对话"是两件事：前者是 /sessions 只读查询，后者是 /task
 * 带 session 目标投递。session 目标**绝不**静默降级为新建——任何失败都返回稳定
 * reason 且不创建任何会话/工作区。
 *
 * 与动态插件版本的关键差异：宿主插件运行在完整 Node 环境，
 * AbortSignal 可用，因此 followup 的 cold-resume 路径不再降级。
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ASSOC_REASONS,
  isValidOrigin,
  openAssociations,
} from './codex-associations.mjs'
import { rememberTask } from './task-table.mjs'
import { createAuditTailReader } from './audit-tail.mjs'
import { createSessionObservationHub } from './session-observer.mjs'
import { createModelRouting } from './model-route-host.mjs'
import { DEFAULT_ROUTE_LIMITS } from './model-routing.mjs'
import {
  REASONS,
  textOfBlocks,
  assistantTextOf,
  baselineOf,
  extractNewAssistantText,
  pickSessionResult,
  classifyTarget,
  selectSession,
  mapControllerError,
  sessionTitleOf,
  looksLikeDisabledSearch,
  rankTitleCandidates,
  taskResponse,
  createRequestTracker,
  consumeSessionEvent,
  consumeSnapshotFrame,
  turnOutcome,
  openTurnsOf,
  currentOpenTurn,
  turnHasEnded,
  findRequestEvidence,
} from './session-target.mjs'
import {
  APPROVAL_REASONS,
  APPROVAL_STATES,
  DECISIONS,
  MAX_AUTHORIZED_TTL_MS,
  controlCredDigest,
  keyFingerprint8,
  openApprovalStore,
  readControlKey,
  verifyControlHeader,
  controlKeyPath,
} from './codex-approvals.mjs'

export const name = 'dsh-bridge'

export const inject = ['webServer', 'agents', 'subagents', 'tools']

export async function apply(ctx) {
  const webServer = ctx.webServer
  const agents = ctx.agents
  const subagents = ctx.subagents
  const timer = ctx.get('timer')
  const sessionQuery = ctx.get('sessionQuery')
  const agentPresets = ctx.get('agentPresets')
  const sessionPersistence = ctx.get('sessionPersistence')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const llm = ctx.get('llm')
  // 已有会话的读写入口。**必须惰性取**：@deepseek-ai/dsh-api-session-controller 的
  // sessionController 由组合异步注册（DSH 启动日志里它先处于 waiting for services），
  // 在 apply() 时捕获会永久拿到 undefined。每次使用时现取；缺失时返回稳定的
  // session-controller-unavailable，而不是让整个插件挂掉。
  const sessionControllerNow = () => ctx.get('sessionController')
  const bridgeVersion = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return 'unknown' } })()
  const observations = createSessionObservationHub({
    ctx, query: () => sessionQuery, controller: sessionControllerNow,
    liveSession: (id) => ctx.get('sessions')?.get?.(id) || agents?.get?.(id)?.session,
  })
  ctx.effect(() => () => observations.close())

  // 清理历史版本可能泄漏的路由条目（重启前的动态插件、旧版本次插件）
  try {
    if (webServer.exact instanceof Map) {
      webServer.exact.delete('/api/dsh-bridge/task')
      webServer.exact.delete('/api/dsh-bridge/status')
      webServer.exact.delete('/api/dsh-bridge/debug')
      webServer.exact.delete('/api/dsh-bridge/review')
      webServer.exact.delete('/api/dsh-bridge/tasks')
      webServer.exact.delete('/api/dsh-bridge/cancel')
      webServer.exact.delete('/api/dsh-bridge/sessions')
    }
    if (webServer.upgrades instanceof Map) webServer.upgrades.delete('/api/dsh-bridge/ws')
  } catch (e) {
    console.error('[dsh-bridge] leaked-route cleanup failed:', e)
  }

  const DEFAULT_WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE || 'D:\\Harness'
  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const isLoopback = (req) => {
    const a = req.socket ? req.socket.remoteAddress : ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }
  const signalOf = () => new AbortController().signal

  const errText = (e) => {
    let s = e && e.message ? String(e.message) : String(e)
    let c = e && e.cause
    let depth = 0
    while (c !== undefined && c !== null && depth < 5) {
      s += ' || cause: ' + (c && c.message ? String(c.message) : String(c))
      c = c && c.cause
      depth += 1
    }
    return s
  }
  const qsOf = (req) => {
    const u = req.url || ''
    const qi = u.indexOf('?')
    if (qi === -1) return {}
    const out = {}
    for (const pair of u.slice(qi + 1).split('&')) {
      const ei = pair.indexOf('=')
      try {
        if (ei === -1) out[decodeURIComponent(pair)] = ''
        else out[decodeURIComponent(pair.slice(0, ei))] = decodeURIComponent(pair.slice(ei + 1))
      } catch (e) { /* skip */ }
    }
    return out
  }
  const normalizeCwd = (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_WORKSPACE
    let p = raw.trim().replace(/\//g, '\\')
    if (p.endsWith('\\')) p = p.slice(0, -1)
    if (p.length >= 2 && p.charAt(1) === ':') p = p.charAt(0).toUpperCase() + p.slice(1)
    return p
  }
  const normalizeLane = (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return 'main'
    const lane = raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    return lane === '' ? 'main' : lane
  }

  const pickModelOptions = () => {
    try {
      for (const a of agents.list()) {
        const o = a.options
        if (o && typeof o.provider === 'string' && typeof o.model === 'string') {
          const out = { provider: o.provider, model: o.model }
          if (o.maxTokens !== undefined) out.maxTokens = o.maxTokens
          return out
        }
      }
    } catch (e) { /* fall through */ }
    try {
      const adm = ctx.get('agentDefaultModel')
      if (adm !== undefined) {
        const sel = adm.currentSelection()
        if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
          return { provider: sel.provider, model: sel.model }
        }
      }
    } catch (e) { /* fall through */ }
    return {}
  }

  // ---- 动态模型路由（M2）----
  // 目录/选择/分类逻辑在 model-routing.mjs，宿主 hook 与归属在 model-route-host.mjs；
  // 这里只负责：策略解析、派活前登记、审计落盘、只读目录路由与能力声明。
  const routeAuditPath = () => (associations === null || typeof associations.dir !== 'string' ? null : associations.dir + '/model-routing.jsonl')
  const routeAuditLines = []
  const appendRouteAudit = (entry) => {
    routeAuditLines.push(entry)
    if (routeAuditLines.length > 400) routeAuditLines.shift()
    const file = routeAuditPath()
    if (file === null) return
    try {
      // 审计目录是 assoc 根下的 namespace 子目录：首次写入前必须建好，否则 appendFileSync 会 ENOENT。
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) { /* 审计失败绝不影响执行 */ }
  }
  const routeAuditReader = createAuditTailReader({ file: routeAuditPath, fallback: () => routeAuditLines })
  const readRouteAudit = (taskId, limit) => routeAuditReader.read(taskId, limit)
  const modelRouting = createModelRouting({
    ctx,
    llm,
    agents: () => (typeof agents !== 'undefined' ? agents : undefined),
    // 官方选择意图（`model/selection`）用真实会话日志判定：同值的人工重选也必须被尊重
    readSessionEvents: (sessionId) => readSessionEvents(sessionId),
    // 默认选择只读快照（绝不用它写任何配置）
    selectionOf: () => {
      const base = pickModelOptions()
      return typeof base.provider === 'string' && typeof base.model === 'string' ? { provider: base.provider, model: base.model } : null
    },
    baseSelection: (() => { const base = pickModelOptions(); return typeof base.provider === 'string' && typeof base.model === 'string' ? { provider: base.provider, model: base.model } : null })(),
    audit: appendRouteAudit,
    limits: DEFAULT_ROUTE_LIMITS,
  })
  const uninstallModelRouting = modelRouting.install()
  // 插件卸载 → hook 与绑定全部失效（在途异步返回不得复活策略）
  ctx.effect(() => () => { try { uninstallModelRouting() } catch (e) { /* ignore */ } })

  /**
   * 把调用方的模型输入解析成任务级策略（第四次交付契约）：
   *  - 缺省/`auto` → auto（默认）；`fast`/`pro` → 兼容偏好；`default` → inherit；
   *  - 给了精确 model（非别名）→ exact（provider 可选，缺省时同名歧义会被拒绝并给候选）；
   *  - `modelFallback` 显式 false 即关闭；精确指定默认关闭（调用方显式 true 才允许降级）。
   */
  const parseRoutePolicy = (parsed) => {
    const rawModel = typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model.trim() : (typeof parsed.modelAlias === 'string' ? parsed.modelAlias.trim() : '')
    const provider = typeof parsed.provider === 'string' && parsed.provider.trim() !== '' ? parsed.provider.trim() : undefined
    const explicitFallback = parsed.modelFallback === undefined ? undefined : parsed.modelFallback === true
    let mode = 'auto'
    let model
    if (rawModel === 'fast' || rawModel === 'pro') mode = rawModel
    else if (rawModel === 'default' || rawModel === '') mode = rawModel === 'default' ? 'inherit' : 'auto'
    else if (rawModel === 'auto') mode = 'auto'
    else { mode = 'exact'; model = rawModel }
    if (mode === 'inherit') return { mode, provider: undefined, model: undefined, allowFallback: explicitFallback === true, taskKind: parsed.taskKind }
    return {
      mode,
      provider: mode === 'exact' ? provider : undefined,
      model: mode === 'exact' ? model : undefined,
      // auto/fast/pro 默认允许切换；精确指定默认固定，除非调用方显式开启
      allowFallback: explicitFallback === undefined ? (mode !== 'exact') : explicitFallback,
      taskKind: typeof parsed.taskKind === 'string' ? parsed.taskKind : 'code',
    }
  }

  // ---- model alias resolution ----
  const modelAliasCache = new Map()
  let knownModels = []
  let modelProvider = ''
  let modelListError = ''
  const resolveModel = async (alias) => {
    if (typeof alias !== 'string' || alias === '' || alias === 'default') return null
    if (modelAliasCache.has(alias)) return modelAliasCache.get(alias)
    if (llm === undefined) return null
    let result = null
    try {
      const base = pickModelOptions()
      const provider = base.provider
      if (typeof provider === 'string' && provider !== '') {
        modelProvider = provider
        const models = await llm.listModels(provider)
        const idOf = (m) => (typeof m === 'string' ? m : (m.id || m.name || ''))
        knownModels = models.map(idOf).filter((x) => x !== '').slice(0, 30)
        if (alias === 'pro') {
          const hit = models.find((m) => /pro/i.test(idOf(m)))
          result = hit !== undefined ? idOf(hit) : null
        } else if (alias === 'fast') {
          const hit = models.find((m) => /flash|lite|fast|mini|light/i.test(idOf(m)))
          result = hit !== undefined ? idOf(hit) : null
        }
      }
    } catch (e) {
      modelListError = errText(e).slice(0, 300)
      console.error('[dsh-bridge] model list failed:', modelListError)
    }
    modelAliasCache.set(alias, result)
    console.log('[dsh-bridge] model alias', alias, '->', result)
    return result
  }

  // ---- collaboration history（由 Codex 侧 task.mjs 维护并随请求同步）----
  let history = []
  const syncHistory = (incoming) => {
    if (Array.isArray(incoming)) {
      const valid = incoming.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
      history = valid.slice(-40)
    }
  }
  const remember = (role, text) => {
    history.push({ role: role, text: text })
    if (history.length > 40) history.splice(0, history.length - 40)
  }
  const historyDigest = () => {
    if (history.length === 0) return ''
    const lines = ['【此前协作历史摘要】']
    for (const h of history) {
      const who = h.role === 'user' ? 'Codex 指令' : '你的汇报'
      lines.push(who + ': ' + h.text.slice(0, 2000))
    }
    return lines.join('\n')
  }

  // ---- per-(cwd, lane) 编码桶 + per-cwd 评审桶 ----
  const buckets = new Map()
  const reviewerBuckets = new Map()
  const tasks = []
  const sockets = new Set()

  /** 把持久记录投影成"跨回合可读"的形态。 */
  const projectStoredTask = (record) => {
    const liveTask = tasks.find((t) => t.taskId === record.taskId)
    const terminal = record.status === 'done' || record.status === 'error' || record.status === 'cancelled'
    // 投递控制（第四轮 A）：父关系/投递模式/回执证据是**不可变事实**，所有投影都必须带上。
    const deliveryFields = {
      ...(record.deliver === undefined ? {} : { deliver: record.deliver }),
      ...(record.parentTaskId === undefined ? {} : { parentTaskId: record.parentTaskId }),
      ...(record.receiptState === undefined ? {} : { receiptState: record.receiptState }),
      ...(record.observedTurn === undefined ? {} : { observedTurn: record.observedTurn }),
      ...(record.resultScope === undefined ? {} : { resultScope: record.resultScope }),
      ...(record.requestSeq === undefined ? {} : { requestSeq: record.requestSeq }),
    }
    const base = {
      taskId: record.taskId,
      originThreadId: record.originThreadId,
      kind: record.kind,
      target: record.target,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      live: liveTask !== undefined,
      ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
      ...(record.dshTurn === undefined ? {} : { dshTurn: record.dshTurn }),
      ...deliveryFields,
    }
    if (liveTask !== undefined) {
      return {
        ...base,
        status: liveTask.status,
        deliver: liveTask.deliver,
        ...(liveTask.receiptState === undefined ? {} : { receiptState: liveTask.receiptState }),
        ...(liveTask.observedTurn === undefined ? {} : { observedTurn: liveTask.observedTurn }),
        ...(liveTask.parentTaskId === undefined ? {} : { parentTaskId: liveTask.parentTaskId }),
        ...(liveTask.resultScope === undefined ? {} : { resultScope: liveTask.resultScope }),
        ...(liveTask.result === undefined ? {} : { result: liveTask.result }),
        ...(liveTask.error === undefined ? {} : { error: liveTask.error }),
        ...(liveTask.delivered === undefined ? {} : { delivered: liveTask.delivered }),
      }
    }
    // 回执的"自身已被观察到"是**独立于父任务执行**的持久事实：重启后不能降级成 unknown。
    if (record.deliver === 'steer' && record.receiptState === 'observed') {
      return {
        ...base,
        status: 'receipt-observed',
        receiptState: 'observed',
        resultScope: record.resultScope === undefined ? 'parent-task' : record.resultScope,
        ...(record.observedTurn === undefined ? {} : { observedTurn: record.observedTurn }),
        ...(record.delivered === undefined ? {} : { delivered: record.delivered }),
        note: '补充回执已被官方回合接收并观察到（自身证据）；父任务的执行结果请查父 task（本回执不承载父结果）。',
      }
    }
    if (record.deliver === 'steer' && record.receiptState !== undefined && record.receiptState !== 'observed') {
      // 回执已接收但未观察到/已偏离：同样是持久事实，不重发。
      return {
        ...base,
        status: record.status === 'receipt-deviated' ? 'receipt-deviated' : (record.status === 'receipt-unconfirmed' ? 'receipt-unconfirmed' : 'receipt-pending'),
        receiptState: record.receiptState,
        resultScope: record.resultScope === undefined ? 'parent-task' : record.resultScope,
        ...(record.observedTurn === undefined ? {} : { observedTurn: record.observedTurn }),
        resend: false,
        note: '回执已提交但未（或未按目标回合）观察到自身 rpcId 落进父回合；**不要重发**，父任务结果请查父 task。',
      }
    }
    if (terminal) {
      return {
        ...base,
        status: record.status,
        ...(record.result === undefined ? {} : { result: record.result }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.delivered === undefined ? {} : { delivered: record.delivered }),
      }
    }
    // 没有本实例运行上下文的非终态记录：**只能**标未知，绝不谎报"还在被本实例观察"。
    return {
      ...base,
      status: 'unknown',
      persistedStatus: record.status,
      reason: 'execution-state-unconfirmed',
      resend: false,
      note: '这条任务在执行/交付未确认前就失去了运行时上下文（网关重载或新实例）；本实例不观察它、不重发。原目标见 target。',
    }
  }

  /** 同通道已有在途任务：明确拒绝，而不是把完成结果猜给某个 pending。 */
  const rejectBusy = (fields) => {
    const task = {
      taskId: uid(), kind: fields.kind, instruction: fields.instruction,
      cwd: fields.cwd, lane: fields.lane, bucketKey: fields.bucketKey,
      target: fields.target, status: 'error', time: Date.now(), result: undefined,
      error: fields.error, reason: fields.reason,
      ...(fields.activeTaskId === undefined ? {} : { activeTaskId: fields.activeTaskId }),
    }
    rememberTask(tasks, task)
    // 仍然登记来源（如果调用方给了）：让调用方能按来源查到"这次被拒绝了"。
    const bound = bindAssociation(task, fields.originThreadId)
    if (bound.ok) persistTask(task)
    pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd: fields.cwd, kind: fields.kind, ...(fields.activeTaskId === undefined ? {} : { activeTaskId: fields.activeTaskId }) })
    return task
  }

  /**
   * 把任务关联存储（R1）：把「来源 Codex 对话 → taskId → 执行目标」持久化，供跨回合精确收取。
   * 打不开就置 null——此时**来源关联模式一律拒绝**，绝不静默降级成"无关联"执行。
   */
  const associations = (() => {
    try {
      return openAssociations({
        root: process.env.DSH_BRIDGE_ASSOC_DIR,
        namespace: process.env.DSH_BRIDGE_ASSOC_NAMESPACE,
        profile: process.env.DSH_PROFILE,
      })
    } catch (e) {
      console.error('[dsh-bridge] association store unavailable:', errText(e).slice(0, 300))
      return null
    }
  })()

  /**
   * 从请求体/查询串解析 originThreadId：
   *   - **字段未传（或 undefined）** → 旧的"无关联"模式，保持兼容；
   *   - **显式给了值** → 必须是合法非空字符串。空串 / null / 纯空白 / 非字符串一律拒绝，
   *     绝不静默回落成"无关联"（那会让调用方以为绑定成功、实际产生未绑定任务）。
   */
  const originOf = (parsed) => {
    if (parsed === null || typeof parsed !== 'object') return { ok: true, originThreadId: undefined }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'originThreadId')) return { ok: true, originThreadId: undefined }
    const raw = parsed.originThreadId
    if (raw === undefined) return { ok: true, originThreadId: undefined }
    if (!isValidOrigin(raw)) return { ok: false }
    return { ok: true, originThreadId: raw.trim() }
  }

  /** 能力上报：客户端在**派活前**只读核验本网关是否真的支持持久来源绑定（旧网关没有这一块）。 */
  const capabilityReport = () => {
    const originBinding = associations === null
      ? { supported: false, version: 0, reason: 'association-store-unavailable' }
      : { supported: true, version: 1, persistence: 'append-only-jsonl', namespace: associations.namespace }
    const key = readControlKey()
    return {
      originBinding,
      approvals: approvalStore === null
        ? { supported: false, enabled: false, reason: 'approval-store-unavailable', canWakeIdle: false }
        : {
            // supported=官方接缝可用；enabled=key 在位（缺 key 整条能力默认关闭）
            supported: true,
            enabled: key !== null,
            ...(key === null ? {} : { keyFp: keyFingerprint8(key) }),
            requiresExplicitEnable: true,   // 委托必须按任务显式开启，提示/文本不构成授权
            requiresKeyHeader: 'X-Dsh-Control',   // 私有 raw key（服务端只存域分离单向摘要）
            activeOnly: true,               // 只在 Codex 活跃循环内生效
            workerSupported: false,         // worker child 身份未证明 → 委托派活会被拒绝
            ptcSupported: false,            // PTC callId/root 未证明 → 嵌套调用直接 next()
            sessionTargetSupported: true,   // 已证明：req.agent.session.id 严格绑定
            canWakeIdle: false,
          },
      // 动态模型路由（M2）：真实 scope/能力声明；新客户端用新参数前必须只读预检这一段。
      modelRouting: {
        supported: true,
        version: 1,
        defaultMode: 'auto',
        modes: ['auto', 'fast', 'pro', 'inherit', 'exact'],
        providerModelPairIdentity: true,
        catalogDiscovery: true,
        metadataHasNoQualityOrPriceScore: true,
        firstRequestBinding: 'agent/inbox/claimed',
        runtimeSwitch: {
          supported: true,
          sameTurnStep: true,
          via: 'agent/request+agent/request-error',
          boundedCandidates: DEFAULT_ROUTE_LIMITS.maxCandidates,
        },
        workerFirstRequest: 'spec.childId+live-registry-equality',
        // 诚实：worker 首请求绑定依赖 provider 真正接受 spec.childId 且 claim 报出同一 agent id；
        // 只有在一次真实 claim 命中后才有证据，因此默认声明**未证明**。
        workerFirstRequestProven: false,
        // worker 后续任务沿用**同一个 durable child**（warm 复用 / cold 官方恢复），入口是官方
        // `subagents.prompt({mode:'continuable',delivery:'queue',requestId})`；不存在 `subagents.followup`。
        workerContinuation: 'subagents.prompt(continuable,queue)',
        workerContinuationProven: false,
        maxCandidates: DEFAULT_ROUTE_LIMITS.maxCandidates,
        limits: { ...DEFAULT_ROUTE_LIMITS },
        structuredCodesOnly: true,
        note: '只枚举已注册配置；目录可见不等于凭据/额度/远端健康已验证，也没有质量/价格/速度评分。',
      },
      // 投递控制（第四轮）：queue 走官方原生 FIFO（一次 claim 一条 next-turn）；steer 是父任务的补充回执。
      // 新字段（deliver=steer / parentTaskId / expectedTurn）遇到没有这段能力的旧网关 → 客户端零派活拒绝。
      delivery: {
        supported: true,
        defaultMode: 'queue',
        modes: ['queue', 'steer'],
        queue: { supported: true, multiTaskPerSession: true, nativeFifo: true, oneTurnPerClaim: true, independentRequestId: true },
        steer: { supported: true, requiresParentTaskId: true, requiresOrigin: true, requiresControlAuth: true, sameTurnAsParent: true, resultScope: 'parent-task', boundedReceiptMs: RECEIPT_OBSERVE_TIMEOUT_MS },
        maxConcurrentPerSession: null,   // 不人为限制；由官方队列顺序决定
      },
    }
  }

  /**
   * 执行前登记关联。失败即返回错误，调用方必须放弃启动 DSH 执行——
   * 绝不出现"执行了却没绑定"。
   */
  const bindAssociation = (task, originThreadId) => {
    if (originThreadId === undefined) return { ok: true }
    if (associations === null) {
      return { ok: false, reason: 'association-store-unavailable', message: 'the task association store could not be opened in this gateway; refusing to dispatch an origin-bound task' }
    }
    try {
      associations.bind({
        originThreadId, taskId: task.taskId, kind: task.kind, target: task.target,
        // 不可变父关系 / 投递模式：**执行前**就落盘（第四轮 A）
        deliver: task.deliver,
        parentTaskId: task.parentTaskId,
        resultScope: task.resultScope,
        requestSeq: task.requestSeq,
        receiptState: task.receiptState,
        route: task.route,
        routePolicy: task.routePolicy,
      })
      task.originThreadId = originThreadId
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e !== null && typeof e === 'object' && typeof e.reason === 'string' ? e.reason : 'association-bind-failed', message: errText(e) }
    }
  }

  /** 把任务当前状态写回持久关联记录（终态/失败/取消/交付确认都调用）。 */
  const persistTask = (task) => {
    if (task === undefined || task === null || task.originThreadId === undefined || associations === null) return
    try {
      associations.update(task.taskId, {
        status: task.status,
        delivered: task.delivered,
        // 回执绝不允许把父任务的旧 result/error 留在落盘记录里（显式 null = 清除）。
        result: task.deliver === 'steer' ? null : task.result,
        error: task.deliver === 'steer' ? null : task.error,
        reason: task.reason,
        stopReason: task.stopReason,
        requestId: task.requestId,
        dshTurn: task.dshTurn,
        // 投递控制（第四轮 A）：父关系/投递模式/回执证据必须随每次落盘一起写，否则重启后全丢。
        deliver: task.deliver,
        parentTaskId: task.parentTaskId,
        receiptState: task.receiptState,
        observedTurn: task.observedTurn,
        resultScope: task.resultScope,
        requestSeq: task.requestSeq,
        // 模型路由（第一版验收修正）：选择与策略随任务落盘，**重启后同 origin/task 仍可取回**
        route: task.route,
        routePolicy: task.routePolicy,
        ...(task.routeStopReason === undefined ? {} : { routeStopReason: task.routeStopReason }),
      })
      delete task.associationError
      // 模型路由收口（M2）：终态**一次**收口（清绑定、落审计）；在途异步返回不得复活策略。
      if ((task.status === 'done' || task.status === 'error' || task.status === 'cancelled') && task.routeFinished !== true) {
        task.routeFinished = true
        try { modelRouting.finishRoute({ taskId: task.taskId, status: task.status, reason: task.reason }) } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // 明确暴露，绝不静默：任务本身的结果不受影响，但调用方能在状态里看到关联写入失败。
      task.associationError = errText(e)
      console.error('[dsh-bridge] association update failed for', task.taskId, ':', errText(e).slice(0, 200))
    }
  }

  // ================================================================ 审批委托（M1/M2，独立验收修正版）

  /** 审批存储：打开失败即能力关闭（capabilities.approvals.enabled=false，审批路由全 401）。 */
  const approvalStore = (() => {
    try {
      return openApprovalStore({ root: process.env.DSH_APPROVAL_DIR, lockTimeoutMs: 10_000 })
    } catch (e) {
      console.error('[dsh-bridge] approval store unavailable:', errText(e).slice(0, 200))
      return null
    }
  })()

  /**
   * 每次请求重读 key（支持轮换）。返回的是**域分离单向摘要**（`digest:…`），
   * 只用于 grant 绑定与审计；它**不能**用于认证（修正 C）。
   */
  const approvalCredDigest = () => {
    const key = readControlKey()
    return key === null ? null : controlCredDigest(key)
  }

  /** 审批类路由鉴权：`X-Dsh-Control` = 私有 raw key，与服务端读到的 key 等值比较。失败零副作用、不回显头。 */
  const approvalAuth = (req) => {
    if (approvalStore === null) return { ok: false, reason: 'approval-store-unavailable' }
    const key = readControlKey()
    if (key === null) return { ok: false, reason: APPROVAL_REASONS.NO_KEY }
    const header = req.headers !== undefined && req.headers !== null ? req.headers['x-dsh-control'] : undefined
    if (!verifyControlHeader(header, key)) return { ok: false, reason: APPROVAL_REASONS.BAD_HEADER }
    return { ok: true, credDigest: controlCredDigest(key) }
  }

  /**
   * **原生入口**（宿主进程内）的鉴权（第二次验收修正 1）：没有 HTTP 头，但绝不能因此变成"无鉴权"。
   * 判据与 HTTP 完全一致——只读**本机已有**的可信控制 key（不接收、不回显、不新增任何凭据/token，
   * 也绝不让模型提供 raw key）：缺 key → no-key；key 存在但格式非法 → bad-header；两者都**零派活**。
   */
  const nativeControlAuth = () => {
    if (approvalStore === null) return { ok: false, reason: 'approval-store-unavailable' }
    const key = readControlKey()
    if (key === null) {
      // 区分"根本没有 key 文件"（能力关闭）与"文件在但格式非法"（坏 key），两者都零派活。
      let raw = null
      try {
        const file = controlKeyPath()
        if (typeof file === 'string' && file !== '') raw = fs.readFileSync(file, 'utf8')
      } catch (e) { raw = null }
      if (raw !== null && typeof raw === 'string' && raw.trim() !== '') return { ok: false, reason: APPROVAL_REASONS.BAD_HEADER }
      return { ok: false, reason: APPROVAL_REASONS.NO_KEY }
    }
    // 复用与 HTTP 相同的格式/等值校验（内部调用把 key 同时当"服务端 key"和"来头值"）。
    if (!verifyControlHeader(key, key)) return { ok: false, reason: APPROVAL_REASONS.BAD_HEADER }
    return { ok: true, credDigest: controlCredDigest(key) }
  }

  /** PTC 嵌套子调用判别器（dsh-tools:1298 `<parentCallId>:ptc:<n>`）：未证明 → 不接手。 */
  const isPtcNestedCall = (callId) => typeof callId === 'string' && /:ptc:\d+$/.test(callId)

  /** 读该会话的日志事件（失败/不可用 → null）。 */
  const readSessionEvents = (sessionId) => observations.evidence(sessionId)

  /**
   * turn/step 证明（修正 A/D）：必须来自日志里**同一个 callId 的 `tool/call`**，且 turn 与 step **都是整数**。
   * 找不到、或只有 turn 没有 step → null（调用方 next()）。**未知 turn/step 绝不能作为可批准默认值。**
   */
  const resolveTurnStepFrom = (events, callId) => {
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event === null || typeof event !== 'object') continue
      if (event.type !== 'tool/call') continue
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      if (data.callId !== callId) continue
      if (!Number.isInteger(data.turn) || !Number.isInteger(data.step)) return null
      return { turn: data.turn, step: data.step, turnSource: 'log-tool-call', stepSource: 'log' }
    }
    return null
  }

  /** 该 session+task+origin 上「未撤销、未过绝对 TTL、凭据摘要匹配」的 grant（租约由等待/决定路径校验）。 */
  const grantForTask = ({ sessionId, taskId, originThreadId, credDigest }) => {
    if (approvalStore === null || credDigest === null) return null
    const now = Date.now()
    for (const g of approvalStore.listGrants({ sessionId, taskId, originThreadId, activeOnly: true })) {
      if (now > g.expiresAt) continue
      const check = approvalStore.validateGrant({ grantId: g.grantId, taskId, originThreadId, sessionId, credDigest }, { ignoreLease: true })
      if (check.ok === true) return check.grant
    }
    return null
  }

  /**
   * **认证活跃委托窗口**（第二轮修正 blocker 3）：只有"仍有效（未撤销/未过绝对 TTL）、凭据摘要匹配、
   * 且严格属于该 task/origin/session"的 grant 才能延长观察窗口——这就是"认证活跃"。
   * 失联（本机 key 没了）→ approvalCredDigest() 为 null → 退回旧预算；撤销/到期 → 同样退回。
   * 注意：不看 lease（慢模型在第一个 ask 之前不该被初始租约卡死），只看 grant 的绝对有效期。
   */
  const activeDelegatedGrantFor = (task) => {
    if (approvalStore === null || task === undefined || task === null) return null
    if (task.target === undefined || task.target.kind !== 'session') return null
    if (typeof task.originThreadId !== 'string' || task.originThreadId === '') return null
    const credDigest = approvalCredDigest()
    if (credDigest === null) return null
    const grant = task.grantId !== undefined
      ? approvalStore.validateGrant({ grantId: task.grantId, taskId: task.taskId, originThreadId: task.originThreadId, sessionId: task.target.sessionId, credDigest }, { ignoreLease: true })
      : { ok: false }
    const resolved = grant.ok === true
      ? grant.grant
      : grantForTask({ sessionId: task.target.sessionId, taskId: task.taskId, originThreadId: task.originThreadId, credDigest })
    if (resolved === undefined || resolved === null || resolved === false) return null
    if (Date.now() > resolved.expiresAt) return null
    return { grantId: resolved.grantId, until: resolved.expiresAt }
  }

  /** 观察预算：无委托=旧语义；有认证活跃委托=以 grant 绝对到期为界（另加宽限与硬上限，仍是有界的）。 */
  const observationBudgetMs = (record, delegated) => {
    if (delegated === null) return SESSION_TOTAL_TIMEOUT_MS
    const untilGrant = Math.max(0, delegated.until - record.startedAt) + DELEGATED_OBSERVATION_GRACE_MS
    return Math.min(Math.max(SESSION_TOTAL_TIMEOUT_MS, untilGrant), MAX_DELEGATED_OBSERVATION_MS)
  }

  /**
   * 该任务当前的 grant 视图（**非秘密**：id/状态/期限），用于 status 响应与客户端自适应续租。
   * 只回属于本任务/来源/会话的 grant；raw key 与摘要绝不出现。
   */
  const delegatedGrantView = (task) => {
    if (approvalStore === null || task === undefined || task === null) return null
    if (typeof task.grantId !== 'string' || task.grantId === '') return null
    const grant = approvalStore.getGrant(task.grantId)
    if (grant === undefined || grant === null) return null
    return { grantId: grant.grantId, status: grant.status, expiresAt: grant.expiresAt, leaseUntil: grant.leaseUntil }
  }

  /** 给**该 grant 的 task** 标 needs-approval（修正 D：不再按 session 找任意活任务）。 */
  const markNeedsApproval = (task, pending) => {
    if (task === undefined || task === null) return undefined
    task.status = 'needs-approval'
    const keys = Array.isArray(task.approvalKeys) ? task.approvalKeys.slice() : []
    if (!keys.includes(pending.approvalKey)) keys.push(pending.approvalKey)
    task.approvalKeys = keys
    task.approvalPendingCount = approvalStore.liveCountForTask(task.taskId)
    pushTask(task.taskId, 'approval', {
      approvalKey: pending.approvalKey, toolName: pending.toolName, taskId: task.taskId,
      target: task.target, approvalState: APPROVAL_STATES.PENDING,
    })
    return task
  }

  /** 决定返回后：**还有别的未决就保持 needs-approval**（修正 E），最后一条解决才回 running。 */
  const restoreAfterDecision = (task) => {
    if (task === undefined || task === null || approvalStore === null) return
    if (task.status !== 'needs-approval') return
    const live = approvalStore.liveCountForTask(task.taskId)
    task.approvalPendingCount = live
    if (live > 0) return
    task.status = 'running'
    pushTask(task.taskId, 'approval-done', { taskId: task.taskId, approvalPendingCount: 0 })
  }

  /** 官方词汇映射：只有官方 decided 的 allowed-once 才算批准。 */
  const outcomeOfPending = (pending) => {
    switch (pending.state) {
      case APPROVAL_STATES.CONFIRMED: return 'allowed-once'
      case APPROVAL_STATES.CANCELLED: return 'cancelled'
      case APPROVAL_STATES.REJECTED: return 'rejected'
      case APPROVAL_STATES.SUBMITTED: return pending.outcome    // 已提交但官方 decided 尚未观测到
      case APPROVAL_STATES.DECISION_UNKNOWN: return undefined
      default: return undefined                                  // expired/context-changed/superseded/ambiguous → 交人工
    }
  }

  /**
   * 等待决定（修正 E）：按**有效租约/绝对 TTL 与 req.signal** 保持（不再有 25s 硬上限；
   * 25s 只是"单次 HTTP/MCP 调用"的有界等待，不能套在真实 SDK callback 上）。
   * 认证续租/续期会移动 lease/expiry；撤销/过期/上下文变化/信号中止立刻收口。
   * **退出前一定关闭可答状态**，交还 next() 之后迟到的批准不可能再被接受。
   */
  const waitForDecision = async (pending, req) => {
    let lastIdentityCheck = 0
    for (;;) {
      const current = approvalStore.getPending(pending.approvalKey)
      if (current === undefined) return undefined
      if (current.state !== APPROVAL_STATES.PENDING) return outcomeOfPending(current)
      const signal = req.signal
      if (signal !== undefined && signal !== null && signal.aborted) {
        approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.CANCELLED, 'request signal aborted')
        return 'cancelled'
      }
      const check = approvalStore.validateGrant({
        grantId: pending.grantId, taskId: pending.taskId, originThreadId: pending.originThreadId,
        sessionId: pending.sessionId, credDigest: approvalCredDigest(),
      })
      if (check.ok !== true) {
        approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.EXPIRED, 'grant no longer valid: ' + check.reason)
        return undefined
      }
      // 完整执行身份（第二轮）：coarse snapshotId + **日志里当前 turn/step**，任一变化 → 收口交还人工。
      // 日志重读按 ~1s 节流（等待本身要保持轻量）。
      if (Date.now() - lastIdentityCheck >= 1000) {
        lastIdentityCheck = Date.now()
        const live = approvalStore.getSnapshot(pending.sessionId, pending.callId)
        if (live === undefined || live.snapshotId !== pending.snapshotId) {
          approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.CONTEXT_CHANGED, 'live execution snapshot changed while pending')
          return undefined
        }
        const events = await readSessionEvents(pending.sessionId)
        const currentSnapshot = approvalStore.getSnapshot(pending.sessionId, pending.callId)
        const currentTurnStep = events === null ? null : resolveTurnStepFrom(events, pending.callId)
        if (currentTurnStep === null) {
          approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.CONTEXT_CHANGED, 'current turn/step can no longer be proven for this call')
          return undefined
        }
        if (currentSnapshot === undefined || approvalStore.executionIdentity(currentSnapshot, currentTurnStep) !== pending.executionId) {
          approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.CONTEXT_CHANGED, 'execution identity changed while pending (tool/root/parent/step/args)')
          return undefined
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /**
   * 正式 answerer：严格谓词不成立一律返回 undefined → 调用方立刻 `next()`（不吞人工/其它 answerer）。
   * 内部异常同样走 next()——绝不 throw：官方 decide 会把 throw 归一成 unavailable，那会跳过人工链。
   */
  const handleApprovalRequest = async (req) => {
    if (approvalStore === null) return undefined
    if (req === null || typeof req !== 'object') return undefined
    if (typeof req.callId !== 'string' || req.callId === '') return undefined            // 无 callId → next()（ACP 同款）
    const session = req.agent !== undefined && req.agent !== null ? req.agent.session : undefined
    const sessionId = session !== undefined && session !== null && typeof session.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return undefined

    // 投递控制 D1：把日志喂给**该会话所有队列执行记录**（幂等，按 seq 去重），
    // 然后由"当前开放回合"选出**唯一**执行 owner——steer 回执永不参与审批归属。
    const events = await readSessionEvents(sessionId)
    if (events === null) return undefined
    const candidatesForTurn = []
    for (const r of queueOwnerRecords(sessionId)) {
      const ownerTask = taskById(r.taskId)
      if (ownerTask === undefined || ownerTask.target === undefined || ownerTask.target.kind !== 'session') continue
      if (typeof ownerTask.originThreadId !== 'string' || ownerTask.originThreadId === '') continue
      if (r.tracker === undefined) continue
      for (const event of events) consumeSessionEvent(r.tracker, event)
      if (r.tracker.sawRequest === true && Number.isInteger(r.tracker.turn)) candidatesForTurn.push({ record: r, task: ownerTask })
    }
    // 同一 callId 的真实 turn/step 由日志证明；本轮 owner 必须**恰好一条**（歧义 → 交人工，绝不任选一条活 task）
    const turnStep = resolveTurnStepFrom(events, req.callId)
    if (turnStep === null) return undefined
    // 首次验收修正 E：owner 必须是**当前真实开放**的那个 queue 任务回合。
    // 只比对历史 tool/call 的 turn 不够——已结束的 A( turn1 ) 会靠旧授权接管 B( turn2 ) 的 ask。
    const openTurn = currentOpenTurn(events)
    if (openTurn === null || openTurn !== turnStep.turn) return undefined
    const owners = candidatesForTurn.filter((c) => c.record.tracker.turn === turnStep.turn && c.record.tracker.end === undefined && c.record.settled !== true)
    if (owners.length !== 1) return undefined
    const record = owners[0].record
    const task = owners[0].task
    // 自己的回合必须仍然开放（tracker.end 未置位且日志里该 turn 没有 turn/end）
    if (turnHasEnded(events, openTurn) === true) return undefined
    const ownTurn = turnStep.turn

    const credDigest = approvalCredDigest()
    if (credDigest === null) return undefined
    const grant = grantForTask({ sessionId, taskId: task.taskId, originThreadId: task.originThreadId, credDigest })
    if (grant === null) return undefined                                                 // 未委托该 task → next()

    const snapshot = approvalStore.getSnapshot(sessionId, req.callId)
    if (snapshot === undefined) return undefined                                         // 无真实参数快照 → next()
    if (snapshot.name !== req.toolName) return undefined
    if (snapshot.identityComplete !== true) return undefined
    if (isPtcNestedCall(req.callId)) return undefined                                    // PTC 嵌套（未证明）→ next()
    if (typeof snapshot.rootCallId === 'string' && snapshot.rootCallId !== req.callId) return undefined   // 父子混淆 → next()
    if (snapshot.parentKey !== null && snapshot.parentKey !== undefined) return undefined // 存在父执行（嵌套未证明）→ next()
    // 登记官方 asked 身份（不依赖 sweep 先跑过）
    observeApprovalEvents(sessionId, events)
    if (approvalStore.annotateSnapshot(sessionId, req.callId, turnStep) === null) return undefined
    const fresh = approvalStore.getSnapshot(sessionId, req.callId)

    // 官方身份（UUID）必须**唯一认领**：歧义/未观测 → 交人工，绝不猜、绝不按 callId 合并（修正 B）
    const candidates = approvalStore.unclaimedAskedFor(sessionId, req.callId, req.toolName)
    if (candidates.length !== 1) return undefined

    const pending = approvalStore.openPending({
      execution: {
        snapshotId: fresh.snapshotId, sessionId, callId: req.callId, toolName: req.toolName,
        rootCallId: fresh.rootCallId, parentKey: fresh.parentKey, cwd: fresh.cwd, cwdSource: fresh.cwdSource,
        args: fresh.args,
        turn: fresh.turn, step: fresh.step, turnSource: fresh.turnSource, stepSource: fresh.stepSource,
      },
      grant,
      reason: req.reason,
      displayReason: req.displayReason,
      askSeq: approvalStore.askCountFor(sessionId, req.callId) + 1,
    })
    // 身份不完整（未知 cwd/父身份等）→ 明确拒绝接手（绝不假装完整）；关键：**不认领官方身份**
    if (pending === null) return undefined
    const claimed = approvalStore.claimOfficialAsk(pending.approvalKey, candidates[0].officialId)
    if (claimed.ok !== true) {
      approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.AMBIGUOUS, 'official request could not be uniquely claimed')
      return undefined
    }
    const marked = markNeedsApproval(task, pending)
    const outcome = await waitForDecision(pending, req)
    if (outcome === undefined) {
      // 交还人工前先关闭可答状态（迟到批准不可能被接受）
      approvalStore.closePending(pending.approvalKey, APPROVAL_STATES.SUPERSEDED, 'handed back to the human chain')
      return undefined
    }
    restoreAfterDecision(marked)
    return outcome
  }

  const broadcast = (msg) => {
    let line
    try { line = JSON.stringify(msg) + '\n' } catch (e) { return }
    for (const s of sockets) {
      try { s.write(line) } catch (e) { /* drop */ }
    }
  }
  const pushTask = (taskId, type, payload) => {
    const msg = { type, taskId, time: Date.now() }
    if (payload !== undefined && payload !== null) {
      for (const k of Object.keys(payload)) msg[k] = payload[k]
    }
    broadcast(msg)
  }

  const bucketOf = (cwd, lane) => {
    const key = cwd + '|' + lane
    let b = buckets.get(key)
    if (b === undefined) {
      b = { key, cwd, lane, model: null, handle: null, agent: null, promise: null, childId: null, childPromise: null, lastSeen: 0, seenCount: 0, activeSince: 0 }
      buckets.set(key, b)
    }
    return b
  }
  const reviewerBucketOf = (cwd) => {
    let b = reviewerBuckets.get(cwd)
    if (b === undefined) {
      b = { key: cwd + '|@review', cwd, lane: '@review', model: null, handle: null, agent: null, promise: null, childId: null, childPromise: null, lastSeen: 0, seenCount: 0, activeSince: 0 }
      reviewerBuckets.set(cwd, b)
    }
    return b
  }

  const registerWorkspace = (cwd) => {
    if (workspaceRegistry === undefined) return
    void (async () => {
      try {
        const existing = await workspaceRegistry.resolveByPath(cwd)
        if (existing === undefined) await workspaceRegistry.create(cwd)
      } catch (e) {
        console.error('[dsh-bridge] workspace register failed for ' + cwd + ':', errText(e).slice(0, 200))
      }
    })()
  }

  const createOwner = async (bucket) => {
    const modelOptions = pickModelOptions()
    let ownerPreset = 'code'
    if (agentPresets !== undefined) {
      const presets = await agentPresets.list()
      const available = (id) => presets.some((p) => p.id === id && !p.broken)
      if (!available('code') && available('standard')) ownerPreset = 'standard'
    }
    const handle = await agents.create({
      sessionId: 'dsh-bridge-owner-' + uid(),
      meta: { cwd: bucket.cwd, origin: 'subagent', agentPreset: ownerPreset },
      agentOptions: modelOptions,
      setup: async (agentCtx) => {
        if (agentPresets !== undefined) await agentPresets.mount(agentCtx, ownerPreset)
      },
    })
    bucket.handle = handle
    bucket.agent = handle.agent
    const b = bucket
    bucket.agent.ctx.on('subagent/end', (info) => { onChildEnd(b, info) })
    console.log('[dsh-bridge] owner ready for', bucket.key, ':', bucket.agent.id)
    return bucket.agent
  }
  const ensureOwner = (bucket) => {
    if (bucket.agent !== null) return Promise.resolve(bucket.agent)
    if (bucket.promise === null) {
      bucket.promise = createOwner(bucket).catch((e) => { bucket.promise = null; throw e })
    }
    return bucket.promise
  }

  const supportsContinuable = (name) => {
    try {
      const p = subagents.getProvider(name)
      return p !== undefined && typeof p.prepareContinuable === 'function'
    } catch (e) { return false }
  }
  const pickProvider = () => {
    if (supportsContinuable('subagent')) return 'subagent'
    let names = []
    try { names = subagents.list() } catch (e) { return undefined }
    for (const n of names) if (supportsContinuable(n)) return n
    return undefined
  }
  const ROLE_BRIEF = (cwd) => [
    '你是在工作目录 ' + cwd + ' 工作的 DeepSeek 编码工人,负责执行 Codex 下发的编码任务。',
    '任务完成后用中文简要汇报:做了什么、改了哪些文件(相对路径)、如何验证、以及需要 Codex 决策的问题。',
    '你的汇报会实时转发给 Codex 供验收。没有新任务时不要主动输出。任务内容如下:',
  ].join('')
  const REVIEWER_BRIEF = (cwd) => [
    '你是工作目录 ' + cwd + ' 的独立代码评审员,与编码员完全分离,不信任任何口头报告。',
    '每次评审请求包含:变更 diff 与审查重点。你必须:',
    '1) 读取工作目录中相关文件的最新内容,核对 diff 与磁盘一致;',
    '2) 静态审查:正确性、健壮性、风格、安全隐患、测试缺口;',
    '3) 实际运行构建与测试命令,验证代码可以跑通——运行失败即判不通过,并附命令与输出摘要;',
    '4) 输出结构化评审报告:【结论:通过/不通过】+【问题列表(按严重度排序,含文件:行号)】+【跑通验证(命令与输出摘要)】+【修改建议】。',
    '不要修改任何文件。没有新请求时不要主动输出。',
  ].join('')

  /** 官方 continuable 语义：父/子 **session id** 精确、queue 投递、本次 taskId 作为 requestId（首请求归属靠它）。
   *  `subagents.prompt` 内部用 `agents.get(parentSessionId)` 找 **live parent Agent** —— 父这一侧是 Agent id。 */
  const parentSessionIdOf = (agent) => (agent !== null && agent !== undefined && typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined)

  /**
   * 继续同一个 durable child（**warm**：live 复用 / **cold**：已自然释放后官方恢复）。
   * 官方 `subagents.prompt({requestId,parentSessionId,childSessionId,mode:'continuable',delivery:'queue',content},signal)`
   * 是唯一正确入口（本机 44 个官方包里**没有** `subagents.followup`）；失败时如实报错，绝不 one-shot 另建 child 冒充继续。
   */
  const promptChild = async (bucket, parent, requestId, text) => {
    if (subagents === undefined || subagents === null || typeof subagents.prompt !== 'function') {
      throw Object.assign(new Error('this host does not expose subagents.prompt (continuable)'), { code: 'WORKER_CONTINUE_UNAVAILABLE' })
    }
    const parentSessionId = parentSessionIdOf(parent)
    const childSessionId = typeof bucket.childSessionId === 'string' && bucket.childSessionId !== '' ? bucket.childSessionId : bucket.childId
    if (typeof parentSessionId !== 'string' || typeof childSessionId !== 'string' || childSessionId === '') {
      throw Object.assign(new Error('continuable prompt needs exact parentSessionId and childSessionId'), { code: 'WORKER_CONTINUE_INVALID' })
    }
    return subagents.prompt({
      requestId,
      parentSessionId,
      childSessionId,
      mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text }],
    }, signalOf())
  }

  const startChildWith = async (bucket, firstInstruction, brief) => {
    const parent = await ensureOwner(bucket)
    const provider = pickProvider()
    if (provider === undefined) throw new Error('no continuable subagent provider registered')
    const digest = historyDigest()
    const request = {
      prompt: [{ type: 'text', text: (digest !== '' ? digest + '\n\n' : '') + brief + firstInstruction }],
      parent,
      toolFilter: { deny: ['dsh_collab_send', 'dsh_collab_review'] },
    }
    if (bucket.model !== null) request.agentOptions = { model: bucket.model }
    const spec = {
      provider,
      label: bucket.lane === '@review' ? 'codex-collab-reviewer' : 'codex-collab-worker-' + bucket.lane,
      request,
      // 预分配 childId：官方要求放在 **startContinuable 顶层 spec.childId**（不是 request.childId）；
      // 有了它，worker 首个 `kind:user`（无 rpcId）的 claim 才能按精确 id 认领路由。
      ...(typeof bucket.expectedChildId === 'string' && bucket.expectedChildId !== '' ? { childId: bucket.expectedChildId } : {}),
      signal: signalOf(),
    }
    // 0.2.1 uses activation delivery; 0.2.0 exposes the original continuable entry.
    // Caller delivery suppresses an unsolicited parent-model turn; lifecycle end remains authoritative.
    const started = typeof subagents.startActivation === 'function'
      ? await subagents.startActivation({ ...spec, delivery: 'caller' })
      : await subagents.startContinuable(spec)
    if (started.result && typeof started.result.catch === 'function') void started.result.catch(() => {})
    bucket.childId = started.childId
    // durable child 的 **session id** 在 warm/cold 下都稳定：冷恢复后仍是同一个 id（官方参考脚本实测）
    bucket.childSessionId = typeof started.sessionId === 'string' && started.sessionId !== '' ? started.sessionId : started.childId
    console.log('[dsh-bridge] worker started for', bucket.key, ':', bucket.childId, 'model:', bucket.model)
    return bucket.childId
  }

  /** 子代理**失败**终态（官方 SubagentResult.stopReason）：这些结束绝不算 done，更不允许 done+空输出。 */
  const SUBAGENT_FAILURE_STOP_REASONS = new Set(['error', 'aborted', 'refusal', 'max-tokens', 'interrupted', 'failed', 'cancelled'])
  const onChildEnd = (bucket, info) => {
    if (bucket.childId === null || info.id !== bucket.childId) return
    const text = textOfBlocks(info.lastAssistantMessage)
    const stopReason = info.stopReason
    const failed = SUBAGENT_FAILURE_STOP_REASONS.has(String(stopReason === undefined || stopReason === null ? '' : stopReason).toLowerCase())
    const pending = tasks.filter((t) => (t.status === 'accepted' || t.status === 'running' || (t.status === 'unknown' && t.taskId === bucket.executingTaskId)) && t.bucketKey === bucket.key)
    const task = pending.length > 0 ? pending[0] : null
    if (task !== null) delete task.awaitingOfficialEnd
    bucket.executingTaskId = null
    bucket.observationAbort?.abort()
    if (failed) {
      // 真实 SDK 终止原因优先：end 只是"子代理结束了"，不等于成功。只按 stopReason 判失败，**不**凭文本空。
      if (task !== null) {
        const routeStop = task.routeStopReason
        task.status = 'error'
        task.error = 'subagent turn ended as "' + String(stopReason) + '"' + (routeStop === undefined ? '' : ' (routeStopReason=' + routeStop + ')') + (text.length > 0 ? '; partial output not treated as success' : '')
        task.reason = routeStop === undefined ? REASONS.SUBAGENT_TURN_FAILED : REASONS.MODEL_ROUTE_EXHAUSTED
        task.stopReason = String(stopReason)
        if (text.length > 0) task.partialResult = text
        persistTask(task)
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, stopReason: task.stopReason, childId: bucket.childId, cwd: bucket.cwd, kind: task.kind })
      } else {
        broadcast({ type: 'error', taskId: null, childId: bucket.childId, time: Date.now(), error: 'subagent turn ended as "' + String(stopReason) + '"', stopReason: String(stopReason), cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
      }
      bucket.activeSince = 0
      return
    }
    if (task !== null) {
      task.status = 'done'
      delete task.error
      delete task.reason
      delete task.partialResult
      delete task.resend
      task.result = text.length > 0 ? text : '(无输出)'
      task.stopReason = stopReason
      remember('user', task.instruction)
      remember('assistant', task.result)
      persistTask(task)
      pushTask(task.taskId, 'result', { text: task.result, stopReason, childId: bucket.childId, cwd: bucket.cwd, kind: task.kind })
    } else {
      broadcast({ type: 'result', taskId: null, childId: bucket.childId, time: Date.now(), text, stopReason, cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
    }
    bucket.activeSince = 0
    bucket.observationAbort?.abort()
  }

  const deliver = async (bucket, instruction, brief, followupPrefix, requestId) => {
    const parent = await ensureOwner(bucket)
    bucket.progressTail = ''
    if (bucket.childId !== null) {
      const cut = await observations.refresh(bucket.childId, { fresh: true })
      if (!cut) throw new Error('worker continuation refused: a fresh history boundary could not be observed; nothing was sent')
      bucket.observedSeq = cut.cursor
    } else bucket.observedSeq = -1
    bucket.executingTaskId = requestId
    if (bucket.childId === null) {
      if (bucket.childPromise === null) {
        bucket.childPromise = startChildWith(bucket, instruction, brief).catch((e) => { bucket.childPromise = null; throw e })
        await bucket.childPromise
      } else {
        await bucket.childPromise
        await promptChild(bucket, parent, requestId, followupPrefix + instruction)
      }
    } else {
      // warm/cold 继续：同 durable child，官方 `subagents.prompt`（warm 直接复用 live，cold 由官方自然恢复）。
      // **绝不**在这里 one-shot 新建 child（已接受/未确认都不能重做，不清 childId、不丢 nonce 历史）。
      await promptChild(bucket, parent, requestId, followupPrefix + instruction)
    }
    if (tasks.some(t => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)) {
      bucket.observationAbort?.abort()
      bucket.observationAbort = new AbortController()
      observations.subscribe(bucket.childId, {
        afterSeq: bucket.observedSeq ?? -1, signal: bucket.observationAbort.signal,
        address: { kind: 'subagent', parentSessionId: parentSessionIdOf(parent), childSessionId: bucket.childSessionId || bucket.childId, mode: 'continuable' },
        onEvent: event => observeWorkerEvent(bucket, event),
      })
    }
    return { fallback: false, output: '', stopReason: '', fallbackNote: '' }
  }

  // ---- 已有会话：解析 → 派发 → 观察 ----
  const envMs = (name, fallback) => {
    const v = Number(process.env[name])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  /** 派发后被接受、但迟迟没有真正开始跑（仍在排队）的容忍时间。 */
  const SESSION_DISPATCH_TIMEOUT_MS = envMs('DSH_BRIDGE_SESSION_DISPATCH_TIMEOUT_MS', 120000)
  /** 见过 running 之后，多久没有新助手文本算读完了。 */
  const SESSION_QUIET_TIMEOUT_MS = envMs('DSH_BRIDGE_SESSION_QUIET_TIMEOUT_MS', 600000)
  /** 单个会话任务的总预算上限。**未委托**任务按它收口；有认证活跃委托时以 grant 绝对有效期为界。 */
  const SESSION_TOTAL_TIMEOUT_MS = envMs('DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS', 3600000)
  /** 委托任务的观察宽限（grant 到期后仍允许收尾/交接的余量）。 */
  const DELEGATED_OBSERVATION_GRACE_MS = envMs('DSH_BRIDGE_DELEGATED_GRACE_MS', 300000)
  /** 委托观察的硬上限（不超过"授权窗口上限 + 宽限"，保证仍然有界）。 */
  const MAX_DELEGATED_OBSERVATION_MS = MAX_AUTHORIZED_TTL_MS + DELEGATED_OBSERVATION_GRACE_MS
  /** steer 回执的观察上限：只等"自己的 rpcId 落进父回合"，单次有界（≤30s），绝不等父任务结果。 */
  const RECEIPT_OBSERVE_TIMEOUT_MS = envMs('DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS', 30000)
  /** 单次等待之外，回执在**总观察寿命**内继续求证（长工具结束后同父回合的迟到 rpc 仍能被证明）。 */
  const RECEIPT_TOTAL_OBSERVE_MS = envMs('DSH_BRIDGE_RECEIPT_TOTAL_OBSERVE_MS', 15 * 60 * 1000)
  /** 回持续证轮询间隔。 */
  const RECEIPT_POLL_MS = Math.max(50, envMs('DSH_BRIDGE_RECEIPT_POLL_MS', 1000))
  // 观察记录**按 taskId 保存**（投递控制 D1）：同一会话可以同时有多个来源明确的在途任务
  // （queue 排进官方 FIFO；steer 回执与父任务同 turn），每条记录只按**自己**的 rpcId→turn/end 结算，
  // 绝不因为全会话 running/idle 事件就把别的任务标 running/done。
  const sessionTargets = new Map()
  const taskById = (taskId) => tasks.find((t) => t.taskId === taskId)
  const recordForTask = (taskId) => sessionTargets.get(taskId)
  /** 该会话所有未收口的观察记录（顺序 = 入队顺序）。 */
  const sessionRecords = (sessionId) => Array.from(sessionTargets.values()).filter((r) => r.sessionId === sessionId && r.settled !== true)
  /** 该会话里**可作为审批 owner** 的队列执行记录（steer 回执永不参与）。 */
  const queueOwnerRecords = (sessionId) => sessionRecords(sessionId).filter((r) => r.deliver !== 'steer' && r.precise === true)
  /**
   * 该记录是否**已真正开始执行**（第四轮 D1）：只有"自己的 rpcId 已被自己的回合认领、且还没收到自己的 turn/end"。
   * 排队中的任务自己的 rpcId 还没出现在日志里 → 保持 accepted/queued，**不因为会话 running 就标 running**。
   */
  const isExecutingRecord = (record) => record !== undefined && record !== null && record.tracker !== undefined
    && record.tracker.sawRequest === true && record.tracker.end === undefined

  const sessionSearch = async (query) => {
    const controller = sessionControllerNow()
    if (controller === undefined) {
      throw Object.assign(new Error('sessionController service is not mounted in this profile'), { code: 'bridge/no-controller' })
    }
    const value = await controller.search({ query }, signalOf())
    const items = value !== undefined && value !== null && Array.isArray(value.items) ? value.items : []
    return items.filter((it) => it !== null && typeof it === 'object' && typeof it.sessionId === 'string' && it.sessionId !== '')
  }

  /**
   * 退回路径：不打开 search 索引，直接遍历 list（读持久化 header + 投影缓存）。
   * 有些部署把 session-query 索引配成 openAt: "never"，此时 search 永远失败，
   * 而按标题找会话仍必须可用——list 就是不激活 Agent 也能拿到标题的那条路。
   */
  const sessionList = async (query) => {
    const controller = sessionControllerNow()
    if (controller === undefined) {
      throw Object.assign(new Error('sessionController service is not mounted in this profile'), { code: 'bridge/no-controller' })
    }
    const needle = query.toLowerCase()
    const value = await controller.list({}, signalOf())
    const items = value !== undefined && value !== null && Array.isArray(value.items) ? value.items : []
    const out = []
    for (const summary of items) {
      if (summary === null || typeof summary !== 'object' || typeof summary.sessionId !== 'string') continue
      const title = sessionTitleOf(summary)
      if (title !== '' && title.toLowerCase().includes(needle)) {
        out.push({ sessionId: summary.sessionId, snippet: title })
        continue
      }
      if (typeof summary.cwd === 'string' && summary.cwd !== '' && summary.cwd.toLowerCase().includes(needle)) {
        out.push({ sessionId: summary.sessionId, snippet: summary.cwd })
      }
    }
    return out
  }

  /** 先 search，失败就退回 list；返回 {hits, matchedBy} 让调用方看得见走了哪条路。 */
  const sessionFind = async (query) => {
    try {
      return { hits: await sessionSearch(query), matchedBy: 'search' }
    } catch (e) {
      if (!looksLikeDisabledSearch(e)) throw e
      return { hits: await sessionList(query), matchedBy: 'list' }
    }
  }

  /**
   * 查询没命中时给的"近似候选"：读 list（不激活 Agent、不开索引），按 bigram 相似度
   * 与最近更新排序。存在的意义是**不给"探测"留动机**——真实事故里调用方搜不到标题后
   * 发了一条占位消息去试探，那条消息落进用户会话并跑成回合。有了候选，只读就能改词重查。
   */
  const sessionNearMisses = async (query, limit = 5) => {
    const controller = sessionControllerNow()
    if (controller === undefined) return []
    try {
      const value = await controller.list({}, signalOf())
      const items = value !== undefined && value !== null && Array.isArray(value.items) ? value.items : []
      const summaries = []
      for (const summary of items) {
        if (summary === null || typeof summary !== 'object' || typeof summary.sessionId !== 'string') continue
        summaries.push({
          sessionId: summary.sessionId,
          title: sessionTitleOf(summary),
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
        })
      }
      return rankTitleCandidates(query, summaries, limit)
    } catch (e) {
      console.error('[dsh-bridge] near-miss lookup failed:', errText(e).slice(0, 200))
      return []
    }
  }

  /** 只读解析：query → search 选一；sessionId → 直接用。任何不确定性都返回 reason。 */
  const resolveSessionTarget = async (target) => {
    const controller = sessionControllerNow()
    if (controller === undefined) {
      return { ok: false, reason: REASONS.CONTROLLER_UNAVAILABLE, message: 'sessionController service is not mounted in this profile', candidates: [] }
    }
    let hits = []
    let matchedBy = 'sessionId'
    if (target.sessionId === undefined) {
      try {
        const found = await sessionFind(target.query)
        hits = found.hits
        matchedBy = found.matchedBy
      } catch (e) {
        return { ok: false, reason: REASONS.GATEWAY_INTERNAL, message: errText(e), candidates: [] }
      }
    }
    const picked = selectSession(hits, target)
    if (!picked.ok) {
      // 查询落空不是"死路"：附上近似候选，调用方只读就能改词重查（别再发消息探测）。
      if (picked.reason === REASONS.QUERY_EMPTY) {
        return { ...picked, candidates: await sessionNearMisses(target.query) }
      }
      return picked
    }
    let result
    try {
      result = await controller.resolveAgent(picked.sessionId)
    } catch (e) {
      return { ok: false, reason: mapControllerError(e), message: errText(e), candidates: picked.candidates }
    }
    if (result !== undefined && result !== null && result.error !== undefined) {
      return { ok: false, reason: mapControllerError(result.error), message: errText(result.error), candidates: picked.candidates }
    }
    return { ok: true, sessionId: picked.sessionId, snippet: picked.snippet, candidates: picked.candidates, matchedBy }
  }

  /**
   * **非终态状态集合**（第二轮修正 blocker 2）：`needs-approval` 也是"在途"——它表示任务还挂在
   * 同一个会话的同一个 R1 request/turn 上，只差一次审批。漏掉它会让第二个任务被接受并覆盖
   * sessionTargets 原 record（root 复现：busySecondDispatchStatus=202）。
   */
  const NON_TERMINAL_STATUSES = new Set(['accepted', 'queued', 'running', 'needs-approval'])
  const isNonTerminal = (task) => task !== undefined && task !== null && (NON_TERMINAL_STATUSES.has(task.status) || task.awaitingOfficialEnd === true)

  /** 同会话已有在途任务（含等待审批）→ 新派活必须被拒（零 prompt），保住原 record/观察/结果。 */
  const sessionPendingTask = (sessionId) => tasks.find((t) => isNonTerminal(t) && t.target !== undefined && t.target.kind === 'session' && t.target.sessionId === sessionId)

  /**
   * 观测官方 `approval/asked|decided`（修正 F）：
   *   - asked → 建立 officialId ↔ (session, toolName, callId) 台账，供 answerer **唯一认领**（不再"只记最后一个"）；
   *   - decided → 按**具体 officialId** 收敛，且状态由官方 outcome 决定
   *     （allowed-once→confirmed；cancelled/rejected 绝不算批准；未知→decision-unknown）。
   * 只做观测与状态推进，**永不写会话日志**（asked/decided 只有官方服务能写），
   * 也不在 handler 里等自己的 decided（官方是 handler 返回后才 append）。
   */
  const observeApprovalEvents = (sessionId, events) => {
    if (approvalStore === null || !Array.isArray(events)) return
    for (const ev of events) {
      if (ev === null || typeof ev !== 'object') continue
      const data = ev.data !== undefined && ev.data !== null && typeof ev.data === 'object' ? ev.data : {}
      if (ev.type === 'approval/asked' && typeof data.id === 'string') {
        approvalStore.observeOfficialAsked({
          officialId: data.id,
          sessionId,
          toolName: typeof data.toolName === 'string' ? data.toolName : '',
          callId: typeof data.callId === 'string' ? data.callId : undefined,
        })
        continue
      }
      if (ev.type !== 'approval/decided' || typeof data.id !== 'string') continue
      const settled = approvalStore.settleFromOfficial(data.id, typeof data.outcome === 'string' ? data.outcome : 'unknown')
      if (settled.ok !== true) continue
      const pending = approvalStore.listPending({}).find((p) => p.officialId === data.id)
      const ownerTask = pending === undefined ? undefined : tasks.find((t) => t.taskId === pending.taskId)
      if (ownerTask !== undefined) {
        pushTask(ownerTask.taskId, 'approval-official', {
          officialId: data.id,
          outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
          state: settled.state,
          target: { kind: 'session', sessionId },
        })
      }
    }
  }

  const settleSessionTask = (record, status, fields) => {
    if (record.settled) return
    record.settled = true
    if (record.abort !== undefined) { try { record.abort.abort() } catch (e) { /* ignore */ } }
    sessionTargets.delete(record.taskId)
    const task = tasks.find((t) => t.taskId === record.taskId)
    if (task === undefined) return
    // 任务收口只处置**自己这条 task** 的审批挂起项（第四轮 D1：绝不按 session 清掉别的任务/回执的 pending）：    //   - 还在 pending → superseded（交给正式人工/下游链）；
    //   - 已提交但没等到官方 approval/decided 确认 → decision-unknown（不重发放行）。
    if (approvalStore !== null) {
      for (const p of approvalStore.listPending({ sessionId: record.sessionId, taskId: record.taskId })) {
        if (p.state === APPROVAL_STATES.PENDING) {
          approvalStore.closePending(p.approvalKey, APPROVAL_STATES.SUPERSEDED, 'task settled while this approval was still pending')
        } else if (p.state === APPROVAL_STATES.SUBMITTED) {
          approvalStore.markDecisionUnknown(p.approvalKey, 'task settled before an official approval/decided confirmation was observed')
        }
      }
    }
    task.status = status
    if (fields.result !== undefined) task.result = fields.result
    if (fields.error !== undefined) task.error = fields.error
    if (fields.reason !== undefined) task.reason = fields.reason
    if (fields.stopReason !== undefined) task.stopReason = fields.stopReason
    if (fields.delivered !== undefined) task.delivered = fields.delivered
    if (fields.partialResult !== undefined) task.partialResult = fields.partialResult
    if (fields.turnEndKind !== undefined) task.turnEndKind = fields.turnEndKind
    if (fields.note !== undefined) task.note = fields.note
    if (fields.resend !== undefined) task.resend = fields.resend
    if (fields.routeStopReason !== undefined) task.routeStopReason = fields.routeStopReason
    // 精确关联模式：回显这次请求的 requestId 与匹配到的 DSH turn（便于跨回合核对归属）。
    if (record.precise === true) {
      task.requestId = record.taskId
      task.dshTurn = record.tracker === undefined ? undefined : record.tracker.turn
    }
    // 终态（done/error/cancelled/timeout/unknown）一律写回持久关联记录。
    persistTask(task)
    pushTask(task.taskId, status === 'done' ? 'result' : 'error', {
      ...(task.result === undefined ? {} : { text: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      target: { kind: 'session', sessionId: record.sessionId },
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    })
  }

  /**
   * 路由已按"本任务"给出终态（候选耗尽 / 禁 fallback 终止）：这是**可信的本任务终止事实**。
   * 优先让原生 `turn/end` 证据收口（follow 是实时的）；有界兜底再用该事实收口，避免 HTTP 悬挂 accepted。
   * 只处置**本任务**（不 cancel 用户 Agent、不清别人的 inbox、不碰其他 queue、不重派）。
   */
  const scheduleRouteFinalize = (task, reason) => {
    if (task === undefined || task === null || task.routeFinalizeScheduled === true) return
    task.routeFinalizeScheduled = true
    const terminalReason = task.routeStopReason === undefined ? reason : task.routeStopReason
    const settleByFact = () => {
      if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') return
      const record = sessionTargets.get(task.taskId)
      if (record === undefined || record.settled === true) return   // worker 路径由 subagent/end 收口
      settleSessionTask(record, 'error', {
        error: 'model routing stopped this task before a successful turn (routeStopReason=' + String(terminalReason) + ')',
        reason: REASONS.MODEL_ROUTE_EXHAUSTED,
        routeStopReason: terminalReason,
        note: 'route-terminal-fact',
      })
    }
    // 1) 先给原生证据一次机会：读一次会话日志；能拿到本请求的 turn/end 就按原生原因收口（更准确）。
    void (async () => {
      const record = sessionTargets.get(task.taskId)
      if (record !== undefined && record.settled !== true && record.precise === true) {
        await observeSessionLog(record)
        if (record.settled !== true && record.tracker !== undefined && record.tracker.end !== undefined) { settleFromTracker(record); return }
      }
      // 2) 原生证据还没到达（follow/poll 有延迟）→ 用**可信的本任务终止事实**有界收口，绝不悬挂 accepted。
      const waitMs = 250
      const go = () => { try { setTimeout(settleByFact, waitMs) } catch (e) { settleByFact() } }
      if (timer !== undefined && timer !== null && typeof timer.timeout === 'function') {
        try { void Promise.resolve(timer.timeout(waitMs)).then(() => { if (task.status === 'accepted' || task.status === 'running') settleByFact() }, settleByFact) } catch (e) { go() }
      } else go()
    })()
  }

  /**
   * 把"读日志"当成一次**观察机会**（不是完成证明）：把日志事件喂给关联器。
   * 与 live follow 共用同一套规则，靠 seq 去重。
   */
  const observeSessionLog = async (record) => {
    const snap = await observations.since(record.sessionId, record.observedSeq ?? -1)
    if (!snap || record.settled) return
    observeApprovalEvents(record.sessionId, snap.events)
    for (const event of snap.events) consumeSessionEvent(record.tracker, event)
    record.observedSeq = snap.cursor
  }

  /** 精确模式下的进度推送：只推自己那个 turn 的**新增**文本。 */
  const pushPreciseProgress = (record) => {
    const text = record.tracker === undefined ? '' : record.tracker.text
    if (text.length <= record.reported) return
    const delta = text.slice(record.reported)
    record.reported = text.length
    record.activeSince = Date.now()
    const task = tasks.find((t) => t.taskId === record.taskId)
    if (task !== undefined && task.status === 'accepted') task.status = 'running'
    pushTask(record.taskId, 'progress', { text: delta, target: { kind: 'session', sessionId: record.sessionId } })
  }

  /**
   * 依据关联器收尾：只有该请求自己的 turn 以 `completed` 结束才算成功；
   * 其他 kind（aborted/blocked/error/max-tokens/interrupted/forked/unknown）都是**明确的终态失败**。
   */
  const settleFromTracker = (record) => {
    const outcome = turnOutcome(record.tracker.end)
    const text = record.tracker.text.trim()
    const task = tasks.find((t) => t.taskId === record.taskId)
    const routeStop = task === undefined ? undefined : task.routeStopReason
    if (outcome.ok) {
      settleSessionTask(record, 'done', { result: text === '' ? '(无输出)' : text, stopReason: 'request-turn-completed' })
      return
    }
    // 路由已给出本任务终态（耗尽/禁 fallback）→ 用稳定 reason 收口，并保留 routeStopReason；
    // 其余非 completed 结束仍按 TURN_FAILED 如实失败。
    settleSessionTask(record, 'error', {
      error: routeStop === undefined
        ? 'the DSH turn for this request ended as "' + outcome.kind + '" (only "completed" is success)'
        : 'model routing stopped this task (routeStopReason=' + routeStop + '); the DSH turn ended as "' + outcome.kind + '"',
      reason: routeStop === undefined ? REASONS.TURN_FAILED : REASONS.MODEL_ROUTE_EXHAUSTED,
      ...(routeStop === undefined ? {} : { routeStopReason: routeStop }),
      turnEndKind: outcome.kind,
      ...(text === '' ? {} : { partialResult: text }),
    })
  }

  /** 收尾时以「持久日志 + 派发前基线」为准，避免只信流式片段。 */
  const finishSessionTask = (record, stopReason) => {
    if (record.settled) return
    void (async () => {
      // 精确关联模式（带来源）：running→idle 只是"可以读一次日志"的机会，不是完成证明。
      // 只有读到自己请求那个 turn 的 turn/end 才收尾；否则保持未确认，绝不拿旧回合或不相关的
      // 全会话 idleness 判成 done。
      if (record.precise === true) {
        await observeSessionLog(record)
        if (record.settled) return
        if (record.tracker.end !== undefined) { settleFromTracker(record); return }
        record.lastObservation = { at: Date.now(), stopReason, sawRequest: record.tracker.sawRequest, turn: record.tracker.turn }
        return
      }
      let extractedText = ''
      if (sessionQuery !== undefined) {
        try {
          const snap = await observations.capture(record.sessionId)
          const events = snap !== undefined && snap !== null && Array.isArray(snap.events) ? snap.events : []
          observeApprovalEvents(record.sessionId, events)
          const extracted = extractNewAssistantText(events, record.baseline)
          record.baseline = extracted.baseline
          extractedText = extracted.text
        } catch (e) {
          console.error('[dsh-bridge] session result read failed:', errText(e).slice(0, 200))
        }
      }
      // 重读的整轮文本优先；流式累计只在重读失败时兜底——两者相加会重复两遍。
      settleSessionTask(record, 'done', { result: pickSessionResult(record.total, extractedText), stopReason })
    })()
  }

  const watchSessionTask = (record) => {
    record.abort ??= new AbortController()
    record.watcher = 'follow'
    observations.subscribe(record.sessionId, {
      afterSeq: record.observedSeq ?? -1,
      signal: record.abort.signal,
      onUncertain: () => { if (!record.settled) record.watcher = 'poll' },
      onEvent: (event) => {
        if (record.settled) return
        record.observedSeq = event.seq
        observeApprovalEvents(record.sessionId, [event])
        if (record.precise) {
          const outcome = consumeSessionEvent(record.tracker, event)
          const task = taskById(record.taskId)
          if (task && (task.status === 'accepted' || task.status === 'queued') && isExecutingRecord(record)) {
            task.status = 'running'
            pushTask(record.taskId, 'running', { target: { kind: 'session', sessionId: record.sessionId }, deliver: record.deliver })
          }
          if (outcome === 'progress') pushPreciseProgress(record)
          if (outcome === 'settled') settleFromTracker(record)
        } else {
          const text = assistantTextOf(event)
          if (text) { record.total += text; record.activeSince = Date.now(); pushTask(record.taskId, 'progress', { text, target: { kind: 'session', sessionId: record.sessionId } }) }
        }
      },
    })
  }

  /**
   * 回执的**自身输入证据**（第四轮 C）：只用"自己的 rpcId 的 user/message 落在哪个回合"这一条证据。
   * 绝不复用通用 tracker（那会累计父任务的助手文本、被普通 sweep 当成执行收口）。
   * 返回 `{state, evidence}`：state ∈ observed | deviated | pending | unconfirmed。
   */
  const receiptEvidenceOf = async (record, task) => {
    const events = await readSessionEvents(record.sessionId)
    // 读取失败（瞬时故障/会话不可读）：**结论未知**——绝不据此写任何状态（第二次验收修正 2）。
    if (events === null) return { state: 'read-error', evidence: null, events: null }
    if (record.settled === true) return { state: 'settled', evidence: null, events }
    record.sawSuccessfulRead = true      // 只有真的读到过日志，才允许下"未确认"的结论
    const evidence = findRequestEvidence(events, task.taskId)
    const targetTurn = Number.isInteger(record.parentTurn) ? record.parentTurn : (Number.isInteger(task.parentTurn) ? task.parentTurn : undefined)
    if (evidence === null || evidence.turn === null) {
      // 我方 rpcId 还没出现：父回合已结束 → 再也等不到（明确未确认）；父回合仍开放 → 继续等（长工具后的迟到 rpc 仍可被后续查询证明）。
      if (targetTurn !== undefined && turnHasEnded(events, targetTurn)) return { state: 'unconfirmed', evidence: null, events }
      return { state: 'pending', evidence: null, events }
    }
    if (targetTurn === undefined || evidence.turn === targetTurn) return { state: 'observed', evidence, events }
    // 官方把这条补充落进了**另一个回合**（异步 admission / wakingAfterAbort 改道）：如实报告偏离，绝不假成功。
    return { state: 'deviated', evidence, events }
  }

  /** 回执观察的**唯一**终态收口（第二次验收修正 2/3）：幂等 + 单调 + 卸载门闩。 */
  const settleReceiptRecord = (record) => {
    if (record.settled === true && typeof record.receiptWake !== 'function') return
    record.settled = true
    // 释放自己的等待定时器：让循环立刻醒来退出，而不是继续睡到下一个 tick（"及时释放"）。
    if (typeof record.receiptWake === 'function') {
      const wake = record.receiptWake
      record.receiptWake = undefined
      try { wake() } catch (e) { /* ignore */ }
    }
  }

  /** 可被 settle 立刻唤醒的等待（卸载后不再空转）。 */
  const sleepWithWake = (record, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { record.receiptWake = undefined; resolve() }, ms)
    record.receiptWake = () => { clearTimeout(timer); resolve() }
  })

  /**
   * 幂等终态收口：首循环 / 后台续证 / 显式查询续证**共用这一条路径**。
   *  · `record.settled`（卸载/已收口）→ 不读不写；
   *  · 已证终态 `observed`/`deviated` **单调不可回退**（临时读失败/陈旧读取绝不能改回 pending/unconfirmed）；
   *  · `unconfirmed` 只可能由"成功读取证明父回合已结束"或"观察寿命到期"产生，且可被之后的成功读取升级回 observed；
   *  · pending 不重复写。
   */
  const finalizeReceipt = (record, task, outcome, options = {}) => {
    if (record === undefined || record.settled === true) return false
    const current = task.receiptState
    if (current === 'observed' || current === 'deviated') return false          // 已证事实绝不回退
    if (current === 'unconfirmed' && outcome.state !== 'observed') return false  // 只允许"恢复读取后升级"
    if (outcome.state === 'pending' && current === 'pending') return false
    applyReceiptEvidence(record, task, outcome)
    if (outcome.state !== 'pending' && options.keepForQuery !== true) settleReceiptRecord(record)
    return true
  }
  /** 把回执证据写进任务与落盘记录（父结果永不残留）。 */
  const applyReceiptEvidence = (record, task, outcome) => {
    const push = {
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      ...(outcome.text === undefined ? {} : { text: outcome.text }),
    }
    task.resultScope = 'parent-task'
    task.result = undefined                      // 回执不承载父结果；配合 persistTask 的显式清除
    task.resend = false
    if (outcome.observedTurn !== undefined) task.observedTurn = outcome.observedTurn
    if (outcome.requestSeq !== undefined) task.requestSeq = outcome.requestSeq
    task.receiptState = outcome.state
    task.status = outcome.status
    if (outcome.reason !== undefined) task.reason = outcome.reason
    persistTask(task)
    pushTask(task.taskId, outcome.status, {
      parentTaskId: record.parentTaskId, requestId: task.taskId, resultScope: 'parent-task',
      ...(task.observedTurn === undefined ? {} : { observedTurn: task.observedTurn }),
      ...(Number.isInteger(record.parentTurn) ? { parentTurn: record.parentTurn } : {}),
      ...push,
      target: { kind: 'session', sessionId: record.sessionId },
    })
  }

  /**
   * steer 回执观察（第四轮 D1 + 首次验收修正 B/C）：
   *  1. 单次有界等待（默认 ≤30s，`RECEIPT_OBSERVE_TIMEOUT_MS`）→ 观察到就 observed；
   *  2. 界内没等到**不是**永久未确认：转 `receipt-pending` 并在**总观察寿命**（`RECEIPT_TOTAL_OBSERVE_MS`）内后台继续求证，
   *     同时每次显式查询都会再核一次（长工具结束后同父回合的迟到 rpc 仍能被后续查询证明）；
   *  3. 只认"自己的 rpcId 落在服务端捕获的父回合"：落到别的回合 → `receipt-deviated`（真实 observedTurn），
   *     父回合已结束而自己没落进去 → `receipt-unconfirmed`；两者都 `resend:false`。
   *  绝不累计父任务助手文本、绝不等父任务结果、绝不参与审批归属。
   */
  const observeSteerReceipt = async (record, task) => {
    const deadline = Date.now() + RECEIPT_OBSERVE_TIMEOUT_MS
    /** 单次检查 → 收口；返回 true 表示"已有结论（或已卸载）"。瞬时读失败**不写任何状态**。 */
    const step = (check) => {
      if (check.state === 'read-error' || check.state === 'settled') return record.settled === true
      if (check.state === 'observed') {
        finalizeReceipt(record, task, { state: 'observed', status: 'receipt-observed', observedTurn: check.evidence.turn, requestSeq: check.evidence.seq, note: 'receipt-observed' })
        return true
      }
      if (check.state === 'deviated') {
        finalizeReceipt(record, task, { state: 'deviated', status: 'receipt-deviated', reason: REASONS.RECEIPT_TURN_DEVIATED, observedTurn: check.evidence.turn, requestSeq: check.evidence.seq, note: 'RECEIPT-TURN-DEVIATED' })
        return true
      }
      if (check.state === 'unconfirmed') {
        finalizeReceipt(record, task, { state: 'unconfirmed', status: 'receipt-unconfirmed', reason: REASONS.RECEIPT_UNCONFIRMED, note: 'RECEIPT-UNCONFIRMED' })
        return true
      }
      return false
    }
    for (;;) {
      if (record.settled === true) return
      if (step(await receiptEvidenceOf(record, task)) === true) return
      if (record.settled === true) return                 // await 之后：卸载门闩（绝不写盘）
      if (Date.now() >= deadline) break
      await sleepWithWake(record, 250)
    }
    if (record.settled === true) return
    // 界内未观察到：转 pending（**不是**终态），后台在总观察寿命内继续求证。
    finalizeReceipt(record, task, {
      state: 'pending', status: 'receipt-pending', note: 'RECEIPT-PENDING',
      text: '官方已接收这条补充；有界等待窗口内还没观察到自己的 rpcId 落进父回合。**不要重发**：本回执仍在观察寿命内继续求证，也可随时显式查询（父任务结果请查父 task）。',
    })
    if (record.settled === true) return
    const totalDeadline = Date.now() + RECEIPT_TOTAL_OBSERVE_MS
    record.watcher = 'receipt'
    for (;;) {
      await sleepWithWake(record, RECEIPT_POLL_MS)
      if (record.settled === true) return                 // 卸载/已收口 → 零读取、零写盘
      if (step(await receiptEvidenceOf(record, task)) === true) return
      if (record.settled === true) return
      if (Date.now() >= totalDeadline) {
        // 观察寿命到期：**只有"成功读取已证明父回合结束"**才允许 unconfirmed（那条路径在上面的 step 里就已收口）。
        // 到期而证据不足时**绝不臆造未确认**（第二次验收修正 2）：保留 pending 记录，等后续显式查询继续求证。
        record.watcher = record.sawSuccessfulRead === true ? 'receipt-expired' : 'receipt-expired-unread'
        pushTask(task.taskId, 'note', {
          parentTaskId: record.parentTaskId, requestId: task.taskId, resultScope: 'parent-task',
          note: 'RECEIPT-UNRESOLVED',
          text: '官方已接收这条补充；到观察寿命结束仍未取得"自身 rpcId 落进父回合"或"父回合已结束"的证据——**不下结论、不重发**；读取恢复后显式查询即可继续求证。',
          target: { kind: 'session', sessionId: record.sessionId },
        })
        return
      }
    }
  }

  /**
   * 显式查询回执时的**同步续证**（第四轮 C）：状态查询本身就是一次官方证据机会，
   * 因此"长工具结束后同父回合的迟到 rpc"不会因为单次等待窗口过去而永久丢确认。
   * 走**同一条**幂等收口：已证 observed/deviated 不回退；临时读失败什么都不写（第二次验收修正 2）。
   */
  const refreshReceiptNow = async (record, task) => {
    if (record.settled === true) return
    if (task.receiptState !== 'pending' && task.receiptState !== 'accepted' && task.receiptState !== 'unconfirmed') return
    const check = await receiptEvidenceOf(record, task)
    if (record.settled === true) return
    if (check.state === 'observed') {
      finalizeReceipt(record, task, { state: 'observed', status: 'receipt-observed', observedTurn: check.evidence.turn, requestSeq: check.evidence.seq, note: 'receipt-observed' })
      return
    }
    if (check.state === 'deviated') {
      finalizeReceipt(record, task, { state: 'deviated', status: 'receipt-deviated', reason: REASONS.RECEIPT_TURN_DEVIATED, observedTurn: check.evidence.turn, requestSeq: check.evidence.seq, note: 'RECEIPT-TURN-DEVIATED' })
      return
    }
    if (check.state === 'unconfirmed') {
      finalizeReceipt(record, task, { state: 'unconfirmed', status: 'receipt-unconfirmed', reason: REASONS.RECEIPT_UNCONFIRMED, note: 'RECEIPT-UNCONFIRMED' }, { keepForQuery: true })
    }
  }

  /** 派发一条指令进已有会话。任何失败都不创建会话，只落一个 error 任务。 */
  const dispatchToSession = async (instruction, target, deliver, notes, incomingHistory, originThreadId, delegateOptions, steering, routePolicy) => {
    const task = {
      taskId: uid(), kind: 'task', instruction,
      target: { kind: 'session', sessionId: target.sessionId, query: target.query, snippet: target.snippet },
      deliver, notes, status: 'accepted', time: Date.now(), result: undefined, error: undefined,
      cwd: undefined, lane: undefined, bucketKey: undefined,
    }
    rememberTask(tasks, task)
    // 任务作用域的 abort（模型路由预算耗尽时**只终止本任务**；不碰用户回合、不碰别的任务）
    const taskAbort = new AbortController()

    // ---- 投递控制（第四轮）：queue = 排进官方 FIFO 的**独立**任务；steer = 明确父任务的补充回执 ----
    const mode = deliver === 'steer' ? 'steer' : 'queue'
    const parentTaskId = steering !== undefined && steering !== null && typeof steering.parentTaskId === 'string' && steering.parentTaskId !== ''
      ? steering.parentTaskId
      : undefined
    const expectedTurn = steering !== undefined && steering !== null && Number.isInteger(steering.expectedTurn) ? steering.expectedTurn : undefined
    const refuseDispatch = (reason, message) => {
      const bound = bindAssociation(task, originThreadId)
      task.status = 'error'
      task.error = message
      task.reason = reason
      if (bound.ok) persistTask(task)
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, ...(originThreadId === undefined ? {} : { originThreadId }) })
      return { task, failed: { reason, message, candidates: [] } }
    }
    if (mode === 'steer') {
      // 无来源 steer 会改动"可能是别人的"在途任务 → 零投递
      if (originThreadId === undefined) {
        return refuseDispatch(REASONS.ORIGIN_REQUIRED_FOR_STEER, 'unbound steer is refused: it would change a task that may belong to another source. Pass originThreadId and parentTaskId.')
      }
      // 显式父任务是硬要求（绝不按"最近/最老任务"推断）
      if (parentTaskId === undefined) {
        return refuseDispatch(REASONS.PARENT_REQUIRED, 'steer requires an explicit parentTaskId — the parent is never inferred from "most recent"/"oldest" task')
      }
    }

    const resolved = await resolveSessionTarget(target)
    if (!resolved.ok) {
      task.status = 'error'
      task.error = resolved.message
      task.reason = resolved.reason
      task.candidates = resolved.candidates
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason })
      return { task, failed: resolved }
    }
    task.target.sessionId = resolved.sessionId
    if (resolved.snippet !== undefined) task.target.snippet = resolved.snippet
    if (resolved.candidates.length > 0) task.candidates = resolved.candidates
    if (resolved.matchedBy !== undefined) task.matchedBy = resolved.matchedBy

    // ---- 忙时不等于错误（第四轮 D1）：
    //   * 来源绑定的 queue：**允许**在同一会话已有在途任务时接收（排进官方 FIFO，各自独立 requestId/回合/结果）；
    //   * steer：校验父任务（同一来源/会话/profile + 真正在执行 + 回合可证）后作为回执接收；
    //   * 旧无来源（不可精确关联）路径：保持原忙锁；且与新的来源绑定任务**不得混用**（结果归属会被污染）。
    const activeRecords = sessionRecords(resolved.sessionId)
    const legacyActive = activeRecords.some((r) => r.precise !== true)
    if (originThreadId === undefined) {
      const inFlight = sessionPendingTask(resolved.sessionId)
      if (inFlight !== undefined && inFlight.taskId !== task.taskId) {
        return refuseDispatch(REASONS.BUSY, 'another bridge task is already pending on this session')
      }
    } else if (legacyActive) {
      return refuseDispatch(REASONS.LEGACY_MIX_UNSAFE, 'this session already has an unbound (non-precise) bridge task; a source-bound task cannot be attributed safely alongside it — wait for it to finish or use another session')
    }
    if (mode === 'steer') {
      const parent = taskById(parentTaskId)
      if (parent === undefined || parent.target === undefined || parent.target.kind !== 'session') {
        return refuseDispatch(REASONS.PARENT_INVALID, 'unknown parent task ' + parentTaskId)
      }
      if (parent.target.sessionId !== resolved.sessionId) {
        return refuseDispatch(REASONS.PARENT_INVALID, 'parent task ' + parentTaskId + ' belongs to another session')
      }
      if (parent.originThreadId !== originThreadId) {
        return refuseDispatch(REASONS.PARENT_INVALID, 'parent task ' + parentTaskId + ' belongs to another source conversation')
      }
      if (parent.deliver === 'steer') {
        return refuseDispatch(REASONS.PARENT_INVALID, 'a steer receipt cannot itself be a parent')
      }
      if (parent.status === 'done' || parent.status === 'error' || parent.status === 'cancelled' || parent.status === 'unknown') {
        return refuseDispatch(REASONS.PARENT_TERMINAL, 'parent task ' + parentTaskId + ' is already terminal (' + parent.status + '); nothing left to steer — queue a new task instead')
      }
      if (parent.status !== 'running' && parent.status !== 'needs-approval') {
        return refuseDispatch(REASONS.PARENT_QUEUED, 'parent task ' + parentTaskId + ' is ' + parent.status + ' (not executing yet); steering a queued parent is meaningless — wait until it runs')
      }
      // 首次验收修正 B：拒绝只看**缓存** parent.status/tracker——官方日志可能早已"父回合 end + 新回合 start"。
      // 因此这里 fresh 读一次官方日志，用"父回合是否仍是当前开放回合"这一硬证据做预检。
      const parentRecord = recordForTask(parent.taskId)
      const parentTurn = parentRecord !== undefined && parentRecord.tracker !== undefined && Number.isInteger(parentRecord.tracker.turn) ? parentRecord.tracker.turn : undefined
      if (parentTurn === undefined) {
        return refuseDispatch(REASONS.PARENT_INVALID, 'parent task ' + parentTaskId + ' has no provably open turn (no rpcId/turn evidence)')
      }
      if (parentRecord.tracker.end !== undefined) {
        return refuseDispatch(REASONS.PARENT_TERMINAL, 'parent task ' + parentTaskId + ' has already ended its turn (tracker收口证据); nothing left to steer')
      }
      const parentEvents = await readSessionEvents(resolved.sessionId)
      if (parentEvents !== null) {
        if (turnHasEnded(parentEvents, parentTurn)) {
          return refuseDispatch(REASONS.PARENT_TURN_CLOSED, 'parent task ' + parentTaskId + ' 的回合 ' + parentTurn + ' 在官方日志里已经 turn/end；插入没有意义（执行前拒绝、零 prompt）')
        }
        const openTurn = currentOpenTurn(parentEvents)
        if (openTurn !== null && openTurn !== parentTurn) {
          return refuseDispatch(REASONS.PARENT_TURN_CLOSED, 'parent task ' + parentTaskId + ' 的回合 ' + parentTurn + ' 已不是当前开放回合（官方日志当前开放 turn=' + openTurn + '）；执行前拒绝、零 prompt')
        }
      }
      if (expectedTurn !== undefined && expectedTurn !== parentTurn) {
        return refuseDispatch(REASONS.PARENT_TURN_MISMATCH, 'expectedTurn=' + expectedTurn + ' does not match the parent task\'s current turn ' + parentTurn)
      }
      task.parentTaskId = parentTaskId
      task.requestedMode = 'steer'
      task.resultScope = 'parent-task'
      task.receiptState = 'accepted'
      task.observedTurn = undefined
      task.expectedTurn = expectedTurn
      // 服务端**自己捕获**的目标父回合：expectedTurn 可有可无都不会丢目标（B）。
      task.parentTurn = parentTurn
    } else {
      task.requestedMode = 'queue'
      // 队列语义：同一会话已有在途任务时，新任务先落 'queued'（还没轮到它），自己的 rpcId 出现后才变 running。
      if (activeRecords.some((r) => isExecutingRecord(r))) task.status = 'queued'
    }

    // 模型路由（M2）：**派活前**登记任务策略（steer 回执沿父，不另建策略）。
    if (routePolicy !== undefined && mode !== 'steer') {
      task.routePolicy = routePolicy
      const plan = await modelRouting.planRoute({
        taskId: task.taskId,
        policy: routePolicy,
        kind: task.kind,
        execution: 'session',
        originThreadId,
        sessionId: resolved.sessionId,
        // 预算耗尽/托管终态：**不 abort 自己的观察者**（那会丢掉原生 turn/end 证据 → HTTP 悬挂 accepted）。
        // 记录本任务的稳定终止事实，由观察者按原生 turn/end 收口；有界兜底再用该事实收口。
        onTerminal: (info) => {
          const reason = info !== null && typeof info === 'object' && typeof info.reason === 'string' ? info.reason : 'terminal'
          task.routeStopReason = reason
          if (info !== null && typeof info === 'object' && info.exhausted === true) scheduleRouteFinalize(task, reason)
        },
        onExhausted: (reason) => {
          task.routeStopReason = reason
          scheduleRouteFinalize(task, reason)
        },
      })
      const chosen = plan.selection !== null && plan.selection.ok === true ? { provider: plan.selection.pair.provider, model: plan.selection.pair.model } : null
      const reason = plan.selection === null ? 'inherit' : plan.selection.reason
      task.route = {
        mode: routePolicy.mode,
        allowFallback: routePolicy.allowFallback,
        chosen,
        reason,
        ...(plan.selection !== null && plan.selection.ok !== true && Array.isArray(plan.selection.candidates) ? { candidates: plan.selection.candidates.slice(0, 5) } : {}),
      }
      // 精确指定但目录里没有 / 同名跨 provider 歧义 → **派活前拒绝**（绝不静默跑另一个模型）
      if (routePolicy.mode === 'exact' && chosen === null) {
        return refuseDispatch(REASONS.MODEL_ROUTE_INVALID, 'exact model request cannot be satisfied from the registered catalog: ' + reason + (task.route.candidates === undefined ? '' : ' (candidates: ' + task.route.candidates.map((c) => c.provider + '/' + c.model).join(', ') + ')'))
      }
    }

    // 来源关联必须在**实际投递之前**落盘：绑定失败就不投递（宁可失败，也不出现"执行了却没绑定"）。
    const bound = bindAssociation(task, originThreadId)
    if (!bound.ok) {
      task.status = 'error'
      task.error = bound.message
      task.reason = bound.reason
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, target: { kind: 'session', sessionId: resolved.sessionId } })
      return { task, failed: { reason: bound.reason, message: bound.message, candidates: [] } }
    }
    // 模型路由选择：**绑定之后**才持久化（bind 时已带 route/routePolicy；这里只刷新非秘密回显字段，
    // 不再出现 "association update failed: task has no association record" 这种真实日志错误）。
    if (routePolicy !== undefined && mode !== 'steer') persistTask(task)

    // 审批委托时序（方案 §4.1 / 验收要求）：**grant 与 origin 绑定必须在发出 prompt/运行工具之前完成**，
    // 失败则零派活（这里直接返回 error，不进入 prompt/queue）。
    if (delegateOptions !== undefined && delegateOptions !== null) {
      const failDelegate = (reason, message) => {
        task.status = 'error'
        task.reason = reason
        task.error = message
        persistTask(task)
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, target: { kind: 'session', sessionId: resolved.sessionId } })
        return { task, failed: { reason, message, candidates: [] } }
      }
      if (approvalStore === null) {
        return failDelegate('approval-store-unavailable', 'delegated dispatch refused: the approval store could not be opened (nothing was sent)')
      }
      const credDigest = approvalCredDigest()
      if (credDigest === null) {
        return failDelegate(APPROVAL_REASONS.NO_KEY, 'delegated dispatch refused: no valid control key on this gateway — initialize it offline first (nothing was sent)')
      }
      if (task.originThreadId === undefined) {
        return failDelegate(APPROVAL_REASONS.ORIGIN_REQUIRED, 'delegated dispatch refused: the grant must bind task + origin before dispatch (nothing was sent)')
      }
      try {
        const grant = approvalStore.issueGrant({
          originThreadId: task.originThreadId,
          taskId: task.taskId,
          scope: { kind: 'session', sessionId: resolved.sessionId },
          ttlMs: typeof delegateOptions.ttlSec === 'number' ? delegateOptions.ttlSec * 1000 : undefined,
          leaseMs: typeof delegateOptions.leaseSec === 'number' ? delegateOptions.leaseSec * 1000 : undefined,
          credDigest,
          authorization: delegateOptions.authorization,
        })
        approvalStore.audit({
          type: 'grant', phase: 'issued', grantId: grant.grantId, taskId: task.taskId,
          originThreadId: task.originThreadId, sessionId: resolved.sessionId,
          authorization: grant.authorization, how: 'delegate-dispatch',
        })
        task.grantId = grant.grantId
        task.grantExpiresAt = grant.expiresAt
        task.grantLeaseUntil = grant.leaseUntil
      } catch (e) {
        return failDelegate('grant-issue-failed', 'delegated dispatch refused: could not issue the task grant (' + errText(e) + ') — nothing was sent')
      }
    }

    // Exact RPC/turn tracking needs only a sequence floor and open-turn metadata.
    // Legacy callers still need their old text baseline, but borrow rather than clone it.
    let baseline = { count: 0, textLen: 0 }
    const cut = originThreadId !== undefined
      ? await observations.refresh(resolved.sessionId, { fresh: true })
      : await observations.capture(resolved.sessionId)
    if (originThreadId === undefined && cut) baseline = baselineOf(cut.events)
    const record = {
      sessionId: resolved.sessionId, taskId: task.taskId, deliver: mode, baseline,      total: '', sawRunning: false, activeSince: Date.now(), startedAt: Date.now(),
      settled: false, abort: taskAbort, watcher: 'pending',
      observedSeq: cut?.cursor ?? -1,
      // 精确关联模式（带来源）：靠 requestId→rpcId→turn 关联收结果，而不是派发前基线 + 全会话 idle。
      precise: originThreadId !== undefined,
      tracker: createRequestTracker(task.taskId, cut?.cursor),
      reported: 0,      // prompt 被接受 = 消息已进会话队列。此后就不该再把它当"没发出去"（见 sweepSessionTargets）。
      delivered: false, queuedNoted: false,
      // 投递控制：回执记录与父任务同 turn，绝不参与审批归属、也绝不等父任务的最终结果。
      receipt: mode === 'steer',
      parentTaskId,
      // 服务端捕获的目标父回合（B）：观察时以它为准，expectedTurn 只是可选校验。
      parentTurn: task.parentTurn,
    }
    record.tracker.openTurns = openTurnsOf(cut?.evidence || cut?.events || [])
    sessionTargets.set(task.taskId, record)
    if (mode !== 'steer') watchSessionTask(record)

    try {
      const controllerRef = sessionControllerNow()
      if (controllerRef === undefined) {
        sessionTargets.delete(task.taskId)
        record.settled = true
        task.status = 'error'
        task.error = 'sessionController service is not mounted in this profile'
        task.reason = REASONS.CONTROLLER_UNAVAILABLE
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, target: { kind: 'session', sessionId: resolved.sessionId } })
        return { task, failed: { reason: task.reason, message: task.error, candidates: [] } }
      }
      await controllerRef.prompt({
        requestId: task.taskId,
        sessionId: resolved.sessionId,
        mode,
        content: [{ type: 'text', text: instruction }],
      }, taskAbort.signal)
      // 模型路由耗尽时 abort 的是**这个**任务的作用域 signal：观察循环据此收口（不误伤别的任务）。
      record.abort = taskAbort
    } catch (e) {
      const reason = mapControllerError(e)
      sessionTargets.delete(task.taskId)
      record.settled = true
      task.status = 'error'
      task.error = errText(e)
      task.reason = reason
      pushTask(task.taskId, 'error', { error: task.error, reason: reason, target: { kind: 'session', sessionId: resolved.sessionId } })
      return { task, failed: { reason, message: task.error, candidates: [] } }
    }

    record.delivered = true
    task.delivered = true
    if (mode === 'steer') {
      // 回执：只观察"自己的 rpcId 落进父回合"（有界 ≤30s），不等父任务结果（父任务唯一拥有最终结果）。
      void observeSteerReceipt(record, task)
      pushTask(task.taskId, 'receipt-accepted', {
        parentTaskId, requestId: task.taskId, deliver: 'steer', resultScope: 'parent-task',
        target: { kind: 'session', sessionId: resolved.sessionId },
      })
      return { task, failed: null }
    }
    pushTask(task.taskId, 'task-accepted', { target: { kind: 'session', sessionId: resolved.sessionId }, deliver: mode, cwd: resolved.snippet, delivered: true })
    return { task, failed: null }
  }

  const enqueue = async (instruction, incomingHistory, target, modelAlias, kind, deliveryMode, notes, originThreadId, delegateOptions, steering, routePolicy) => {
    if (incomingHistory !== undefined) syncHistory(incomingHistory)
    if (target !== undefined && target.kind === 'session') {
      // session 目标：不注册工作区、不建 owner、不建子代理，失败也不降级为新建。
      const dispatched = await dispatchToSession(
        instruction, target,
        deliveryMode === undefined ? 'queue' : deliveryMode,
        Array.isArray(notes) ? notes : [],
        incomingHistory,
        originThreadId,
        delegateOptions,
        steering,
        routePolicy,
      )
      return dispatched.task
    }
    const cwd = normalizeCwd(target === undefined ? undefined : target.cwd)
    const lane = normalizeLane(target === undefined ? undefined : target.lane)
    registerWorkspace(cwd)
    const bucket = bucketOf(cwd, lane)
    // 同一通道（cwd+lane）只允许一个在途任务：完成事件只能定位到"这个桶里最老的 pending"，
    // 两个并发任务会让结果归属变成猜测。这里明确拒绝（上一任务结束后再派下一条；不同 lane 不受影响）。
    const activeInBucket = tasks.find((t) => (t.status === 'accepted' || t.status === 'running' || (t.status === 'unknown' && t.taskId === bucket.executingTaskId)) && t.bucketKey === bucket.key)
    if (activeInBucket !== undefined) {
      return rejectBusy({
        kind, instruction, cwd, lane, bucketKey: bucket.key,
        target: { kind: 'worker', cwd, lane },
        originThreadId,
        activeTaskId: activeInBucket.taskId,
        reason: 'worker-bucket-busy',
        error: 'another task (' + activeInBucket.taskId + ') is still active on this channel; refusing to start a second one — its completion could not be attributed to a specific task. Wait for it to finish (or use another --lane).',
      })
    }
    const requestedModel = await resolveModel(modelAlias)
    if (requestedModel !== null && requestedModel !== bucket.model) {
      bucket.model = requestedModel
      bucket.childId = null
      bucket.childPromise = null
      bucket.lastSeen = 0
      bucket.seenCount = 0
    }
    const task = { taskId: uid(), kind, instruction, cwd, lane, bucketKey: bucket.key, target: { kind: 'worker', cwd, lane }, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
    rememberTask(tasks, task)
    // 来源关联必须在**实际派活之前**落盘：绑定失败就不派活。
    const bound = bindAssociation(task, originThreadId)
    if (!bound.ok) {
      task.status = 'error'
      task.error = bound.message
      task.reason = bound.reason
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd, kind })
      return task
    }
    // 模型路由（M2）：worker 也要在**首次请求之前**有归属——预先分配 childId 并登记计划，
    // 由 agent/inbox/claimed 用真实 agent/owner 核对后绑定（provider 不支持预分配时不会误绑）。
    if (routePolicy !== undefined) {
      // worker 的 owner 必须在**登记路由之前**确定：claim 时用官方 isOwnedBy 核验，
      // 拿不到可信 owner 就不登记（fail-closed，绝不按 childId 撞一个就算接管）。
      const routeOwner = await ensureOwner(bucket)
      const reuseChildId = bucket.childId !== null && bucket.childId !== undefined ? bucket.childId : null
      const expectedChildId = reuseChildId !== null ? reuseChildId : 'dsh-bridge-child-' + uid()
      const plan = await modelRouting.planRoute({
        taskId: task.taskId, policy: routePolicy, kind, execution: 'worker', originThreadId, childId: expectedChildId,
        expectedOwner: routeOwner !== undefined && routeOwner !== null && typeof routeOwner.id === 'string' ? routeOwner.id : undefined,
        onTerminal: (info) => { task.routeStopReason = info !== null && typeof info === 'object' && typeof info.reason === 'string' ? info.reason : 'terminal' },
        onExhausted: (reason) => { task.routeStopReason = reason },
      })
      bucket.expectedChildId = expectedChildId
      const chosen = plan.selection !== null && plan.selection.ok === true ? { provider: plan.selection.pair.provider, model: plan.selection.pair.model } : null
      const reason = plan.selection === null ? 'inherit' : plan.selection.reason
      task.routePolicy = routePolicy
      task.route = {
        mode: routePolicy.mode,
        allowFallback: routePolicy.allowFallback,
        chosen,
        reason,
        expectedChildId,
        ...(plan.selection !== null && plan.selection.ok !== true && Array.isArray(plan.selection.candidates) ? { candidates: plan.selection.candidates.slice(0, 5) } : {}),
      }
      // 精确指定但目录里没有 / 同名跨 provider 歧义 → **派活前拒绝**（与 session 目标同一契约）
      if (routePolicy.mode === 'exact' && chosen === null) {
        task.status = 'error'
        task.error = 'exact model request cannot be satisfied from the registered catalog: ' + reason
        task.reason = REASONS.MODEL_ROUTE_INVALID
        task.candidates = task.route.candidates === undefined ? [] : task.route.candidates
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd, kind })
        return task
      }
    }
    try {
      const delivered = await deliver(bucket, instruction, ROLE_BRIEF(cwd), '[Codex 指令] ', task.taskId)
      if (delivered.fallback) {
        // 兜底路径**不再冒充成功**：worker 继续失败必须如实 error（不重派、不 one-shot 重做）。
        task.status = 'error'
        task.error = 'worker continuation degraded: ' + delivered.fallbackNote
        task.reason = 'worker-continuation-degraded'
        persistTask(task)
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd, kind })
      } else {
        bucket.activeSince = Date.now()
        pushTask(task.taskId, 'task-accepted', { childId: bucket.childId, cwd, kind })
      }
    } catch (e) {
      task.status = 'error'
      task.error = errText(e)
      persistTask(task)
      pushTask(task.taskId, 'error', { error: task.error, cwd, kind })
    }
    return task
  }

  const submitReview = async (rawCwd, diff, focus, incomingHistory, originThreadId, routePolicy) => {
    if (incomingHistory !== undefined) syncHistory(incomingHistory)
    const cwd = normalizeCwd(rawCwd)
    const bucket = reviewerBucketOf(cwd)
    // 评审桶同理：同一目录只允许一个在途评审，否则完成结果无法归属到具体 taskId。
    const activeReview = tasks.find((t) => (t.status === 'accepted' || t.status === 'running' || (t.status === 'unknown' && t.taskId === bucket.executingTaskId)) && t.bucketKey === bucket.key)
    if (activeReview !== undefined) {
      return rejectBusy({
        kind: 'review', instruction: '(review rejected: channel busy)', cwd, lane: '@review', bucketKey: bucket.key,
        target: { kind: 'worker', cwd, lane: '@review' },
        originThreadId,
        activeTaskId: activeReview.taskId,
        reason: 'reviewer-bucket-busy',
        error: 'another review (' + activeReview.taskId + ') is still active for this directory; refusing to start a second one — its completion could not be attributed to a specific task. Wait for it to finish.',
      })
    }
    const instruction = ['【变更 diff】\n' + (typeof diff === 'string' && diff.trim() !== '' ? diff.slice(0, 60000) : '(未提供 diff)'), '【审查重点】\n' + (typeof focus === 'string' && focus.trim() !== '' ? focus.slice(0, 4000) : '(未指定,请按一般标准审查)')].join('\n\n')
    const task = { taskId: uid(), kind: 'review', instruction, cwd, lane: '@review', bucketKey: bucket.key, target: { kind: 'worker', cwd, lane: '@review' }, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
    rememberTask(tasks, task)
    // 模型路由（评审入口）：与编码走**同一任务级机制**——业务 kind='review'、执行目标 worker；
    // 默认 auto 优先兼容 DeepSeek、支持显式 pair/default/禁 fallback、有界同 turn/step 恢复与独立审计。
    if (routePolicy !== undefined) {
      task.routePolicy = routePolicy
      const routeOwner = await ensureOwner(bucket)
      const reuseChildId = bucket.childId !== null && bucket.childId !== undefined ? bucket.childId : null
      const expectedChildId = reuseChildId !== null ? reuseChildId : 'dsh-bridge-child-' + uid()
      const plan = await modelRouting.planRoute({
        taskId: task.taskId, policy: { ...routePolicy, taskKind: 'review' }, kind: 'review', execution: 'worker',
        originThreadId, childId: expectedChildId,
        expectedOwner: routeOwner !== undefined && routeOwner !== null && typeof routeOwner.id === 'string' ? routeOwner.id : undefined,
        onExhausted: (reason) => { task.routeStopReason = reason },
      })
      bucket.expectedChildId = expectedChildId
      const chosen = plan.selection !== null && plan.selection.ok === true ? { provider: plan.selection.pair.provider, model: plan.selection.pair.model } : null
      const routeReason = plan.selection === null ? 'inherit' : plan.selection.reason
      task.route = {
        mode: routePolicy.mode, allowFallback: routePolicy.allowFallback, chosen, reason: routeReason,
        ...(plan.selection !== null && plan.selection.ok !== true && Array.isArray(plan.selection.candidates) ? { candidates: plan.selection.candidates.slice(0, 5) } : {}),
      }
      // 精确指定但目录里没有 / 同名跨 provider 歧义 → 派活前拒绝（评审也不跑"另一个模型"）
      if (routePolicy.mode === 'exact' && chosen === null) {
        task.status = 'error'
        task.error = 'exact model request cannot be satisfied from the registered catalog: ' + routeReason
        task.reason = REASONS.MODEL_ROUTE_INVALID
        task.candidates = task.route.candidates === undefined ? [] : task.route.candidates
        pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd, kind: 'review' })
        return task
      }
    }
    // 评审同样产生 taskId，因此同样支持来源关联；绑定失败不派活。
    const bound = bindAssociation(task, originThreadId)
    if (!bound.ok) {
      task.status = 'error'
      task.error = bound.message
      task.reason = bound.reason
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, cwd, kind: 'review' })
      return task
    }
    try {
      const delivered = await deliver(bucket, instruction, REVIEWER_BRIEF(cwd), '[评审请求] ', task.taskId)
      if (delivered.fallback) {
        task.status = 'done'
        task.result = delivered.output
        task.stopReason = delivered.stopReason
        task.fallback = delivered.fallbackNote
        remember('user', '[评审请求] ' + (typeof focus === 'string' && focus !== '' ? focus : 'diff 审查'))
        remember('assistant', task.result)
        persistTask(task)
        pushTask(task.taskId, 'result', { text: task.result, stopReason: delivered.stopReason, childId: null, cwd, kind: 'review' })
      } else {
        bucket.activeSince = Date.now()
        pushTask(task.taskId, 'task-accepted', { childId: bucket.childId, cwd, kind: 'review' })
      }
    } catch (e) {
      task.status = 'error'
      task.error = errText(e)
      persistTask(task)
      pushTask(task.taskId, 'error', { error: task.error, cwd, kind: 'review' })
    }
    return task
  }

  // assistantTextOf / textOfBlocks 由 session-target.mjs 提供（同一套语义，可单测）。
  const observeWorkerEvent = (bucket, event) => {
    if (event.seq <= (bucket.observedSeq ?? -1)) return
    bucket.observedSeq = event.seq
    const active = tasks.find(t => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
    if (!active) return
    bucket.activeSince = Date.now()
    const text = assistantTextOf(event)
    if (!text) return
    bucket.progressTail = ((bucket.progressTail || '') + text + '\n').slice(-4000)
    active.status = 'running'
    pushTask(active.taskId, 'progress', { text, cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
  }
  const pollOne = async (bucket) => {
    if (bucket.childId === null || sessionQuery === undefined) return
    const hasPending = tasks.some((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
    if (!hasPending) { bucket.observationAbort?.abort(); return }
    const snap = await observations.since(bucket.childId, bucket.observedSeq ?? -1)
    if (!snap) return
    for (const event of snap.events) observeWorkerEvent(bucket, event)
    bucket.observedSeq = Math.max(bucket.observedSeq ?? -1, snap.cursor)
    const total = bucket.progressTail || ''
    if (bucket.activeSince > 0 && Date.now() - bucket.activeSince > 600000) {
      const active = tasks.find((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
      if (active !== undefined && total.length > 0) {
        active.status = 'unknown'
        active.awaitingOfficialEnd = true
        active.partialResult = total.trim()
        active.reason = REASONS.UNCONFIRMED
        active.resend = false
        active.error = 'worker stopped producing progress without an official completion; do not resend'
        persistTask(active)
        pushTask(active.taskId, 'unknown', { error: active.error, reason: active.reason, partialResult: active.partialResult, resend: false, stopReason: 'quiet-timeout', childId: bucket.childId, cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
        bucket.observationAbort?.abort()
        bucket.activeSince = 0
      }
    }
  }
  // 会话任务的兜底：超时判定 + follow 不可用时的轮询降级。
  const sweepSessionTargets = async () => {
    for (const record of Array.from(sessionTargets.values())) {
      if (record.settled) continue
      const task = tasks.find((t) => t.taskId === record.taskId)
      if (task === undefined) { settleSessionTask(record, 'cancelled', {}); continue }
      if (task.status === 'cancelled') { record.settled = true; if (record.abort !== undefined) { try { record.abort.abort() } catch (e) { /* ignore */ } } sessionTargets.delete(record.taskId); continue }
      const now = Date.now()
      // 回执（第四轮首次验收修正 C）：**绝不**进入通用执行收口。
      // 它的生命周期只由 observeSteerReceipt/refreshReceiptNow 用"自身 rpcId 落进哪个回合"驱动，
      // 因此这里既不喂通用 tracker（会累计父任务助手文本），也不允许 settleFromTracker 抢结算/落盘父结果。
      if (record.receipt === true) continue
      // 精确关联模式：轮询/读日志只是观察机会，收尾只能由"自己那个 turn 的 turn/end"触发。
      if (record.precise === true) {
        if (!observations.healthy(record.sessionId)) await observeSessionLog(record)
        if (record.settled) continue
        // 按"自己的证据"推进 accepted/queued → running（全会话 running 事件只是机会，不是判定）。
        if (record.receipt !== true && (task.status === 'accepted' || task.status === 'queued') && isExecutingRecord(record)) {
          task.status = 'running'
          pushTask(task.taskId, 'running', { target: { kind: 'session', sessionId: record.sessionId }, deliver: record.deliver })
        }
        if (record.tracker.end !== undefined) { settleFromTracker(record); continue }
        if (record.watcher !== 'follow') pushPreciseProgress(record)
        if (!record.sawRunning && now - record.startedAt > SESSION_DISPATCH_TIMEOUT_MS && record.delivered === true && record.queuedNoted !== true) {
          record.queuedNoted = true
          pushTask(record.taskId, 'note', {
            note: 'QUEUED',
            text: 'prompt 已被接受并进入该会话队列，等它空闲时会跑；不要重发',
            target: { kind: 'session', sessionId: record.sessionId },
            delivered: true,
          })
        }
        if (!record.sawRunning && now - record.startedAt > SESSION_DISPATCH_TIMEOUT_MS && record.delivered !== true) {
          settleSessionTask(record, 'error', { error: 'the session never accepted the prompt', reason: REASONS.NOT_ACCEPTED, delivered: false })
          continue
        }
        // 等待审批期间：**不按 quiet/派发超时判完成或失败**（有效租约必须被尊重）；
        // 观察预算 = 有效认证委托的 grant 有效期（blocker 3），未委托/失联/撤销/到期才回到旧预算。
        const delegated = activeDelegatedGrantFor(task)
        const budgetMs = observationBudgetMs(record, delegated)
        if (task.status === 'needs-approval') {
          if (now - record.startedAt > budgetMs) {
            settleSessionTask(record, 'unknown', {
              error: '等待审批超过了有效观察窗口（委托 grant 已到期/撤销/失联，或未委托时超过总预算）；执行状态未确认，不要重发（审批链已交还人工）',
              reason: REASONS.UNCONFIRMED,
              resend: false,
              note: delegated === null ? 'approval wait exceeded SESSION_TOTAL_TIMEOUT_MS' : 'delegated grant window closed (' + delegated.grantId + ')',
              ...(record.delivered === true ? { delivered: true } : {}),
            })
          }
          continue
        }
        // quiet / 总预算到期但**没有**自己 turn 的结束证据：只能报未确认（resend:false），绝不猜 done。
        // 有认证活跃委托时不做 quiet 判定（慢模型长时间无输出是正常的，grant 有效期才是界）。
        const quietExpired = delegated === null && record.sawRunning && record.activeSince > 0 && now - record.activeSince > SESSION_QUIET_TIMEOUT_MS
        const budgetExpired = now - record.startedAt > budgetMs
        if (quietExpired || budgetExpired) {
          settleSessionTask(record, 'unknown', {
            error: record.delivered === true
              ? 'prompt 已投递进该会话队列，但没有观察到本请求自己那个 turn 的结束（可能仍在排队/仍在跑/已被别的回合掩盖）；执行状态未确认，不要重发'
              : 'the session never accepted the prompt within the budget',
            reason: REASONS.UNCONFIRMED,
            resend: false,
            note: 'execution state unconfirmed: no turn/end matching this request\'s requestId was observed',
            ...(record.delivered === true ? { delivered: true } : {}),
          })
        }
        continue
      }
      if (record.watcher === 'poll' && sessionQuery !== undefined) {
        try {
          const snap = await observations.capture(record.sessionId)
          const events = snap !== undefined && snap !== null && Array.isArray(snap.events) ? snap.events : []
          observeApprovalEvents(record.sessionId, events)
          const extracted = extractNewAssistantText(events, record.baseline)
          record.baseline = extracted.baseline
          if (extracted.text.trim() !== '') {
            record.total += extracted.text
            record.activeSince = now
            if (task.status === 'accepted') task.status = 'running'
            pushTask(record.taskId, 'progress', { text: extracted.text, target: { kind: 'session', sessionId: record.sessionId } })
          }
        } catch (e) { /* 读不到就下一轮再试 */ }
      }
      // 等待审批期间不走 legacy 的 quiet/total/派发超时；观察预算同上（有效认证委托按 grant 有效期）。
      const delegated = activeDelegatedGrantFor(task)
      const budgetMs = observationBudgetMs(record, delegated)
      if (task.status === 'needs-approval') {
        if (now - record.startedAt > budgetMs) {
          settleSessionTask(record, 'unknown', {
            error: '等待审批超过了有效观察窗口（委托 grant 已到期/撤销/失联，或未委托时超过总预算）；执行状态未确认，不要重发（审批链已交还人工）',
            reason: REASONS.UNCONFIRMED,
            resend: false,
            note: delegated === null ? 'approval wait exceeded SESSION_TOTAL_TIMEOUT_MS' : 'delegated grant window closed (' + delegated.grantId + ')',
            ...(record.delivered === true ? { delivered: true } : {}),
          })
        }
        continue
      }
      // 派发超时只在"prompt 没被接受"时才算失败。
      // queue 模式下 prompt 被接受就意味着消息已进队列，会在会话空闲时跑；此时报 error
      // 是误报——实测会话正跑一个 38 分钟的回合，排队等待远超 120s 完全正常，而误报会
      // 直接诱导调用方重发（真实事故：同一条汇报被投了两次）。所以这里只记一条 note，
      // 继续等，由下面的总预算兜底。
      if (!record.sawRunning && now - record.startedAt > SESSION_DISPATCH_TIMEOUT_MS) {
        if (record.delivered === true) {
          if (record.queuedNoted !== true) {
            record.queuedNoted = true
            pushTask(record.taskId, 'note', {
              note: 'QUEUED',
              text: 'prompt 已被接受并进入该会话队列，等它空闲时会跑；不要重发',
              target: { kind: 'session', sessionId: record.sessionId },
              delivered: true,
            })
          }
        } else {
          settleSessionTask(record, 'error', { error: 'the session never accepted the prompt', reason: REASONS.NOT_ACCEPTED, delivered: false })
          continue
        }
      }
      // 有认证活跃委托时不按 quiet 判完成（慢模型长时间无输出正常；grant 有效期才是界）。
      if (delegated === null && record.sawRunning && record.activeSince > 0 && now - record.activeSince > SESSION_QUIET_TIMEOUT_MS) {
        finishSessionTask(record, 'quiet-timeout')
        continue
      }
      if (now - record.startedAt > budgetMs) {
        settleSessionTask(record, 'error', {
          error: record.delivered === true
            ? 'prompt 已投递进该会话队列，但预算内它始终没有开始这一轮（会话可能一直在忙，或未被激活）；不要重发，可用 status 继续观察'
            : 'session task exceeded its total budget before the prompt was accepted',
          reason: REASONS.TIMEOUT,
          delivered: record.delivered === true,
        })
      }
    }
  }

  // 完成信号：会话从 running 回到 idle 即这一轮结束（follow 只负责流式进度）。
  // 订阅的是 ctx 上的事件，与服务何时注册无关，所以不设门禁。
  {
    ctx.effect(() => {
      const off = ctx.on('api-session/status', (sessionId, running) => {
        // 全会话 running/idle 只是"再观察一次"的机会（第四轮 D1）：绝不据此把同会话的其它任务标 running/done。
        // 每个任务仍必须靠**自己**的 rpcId→turn/end 结算（settleFromTracker / finishSessionTask）。
        for (const record of sessionRecords(sessionId)) {
          const task = taskById(record.taskId)
          if (task === undefined) continue
          // 回执：共享 running/idle 只当"再看一眼自身证据"的机会，绝不进通用执行收口（C）。
          if (record.receipt === true) {
            if (running === true) record.sawRunning = true
            void refreshReceiptNow(record, task)
            continue
          }
          if (running === true) {
            record.sawRunning = true
            record.activeSince = Date.now()
            // 先读一次日志把 rpcId 喂给关联器，再按"自己的证据"决定是否 running（否则会误标排队中的任务）。
            void (async () => {
              await observeSessionLog(record)
              if (record.settled) return
              if ((task.status === 'accepted' || task.status === 'queued') && isExecutingRecord(record)) {
                task.status = 'running'
                pushTask(task.taskId, 'running', { target: { kind: 'session', sessionId: record.sessionId }, deliver: record.deliver })
              }
            })()
            continue
          }
          if (running === false && record.sawRunning) finishSessionTask(record, 'stop')
        }
      })
      return () => { if (typeof off === 'function') off() }
    })
  }

  // ---- 正式审批接线（M0 证据：cordis:317-325 组合语义 / user-approval:176 waterfall /
  //      acp:1116 无 callId 即 next / ui-approval:284 只在自己会话内接管）
  // 1) tools/pre-execute 快照：真实参数的唯一来源（客户端不得代传）；只记录，原链透传。
  ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', (exec, next) => {
      try {
        const session = exec !== null && typeof exec === 'object' && exec.agent !== undefined && exec.agent !== null ? exec.agent.session : undefined
        const sessionId = session !== undefined && session !== null && typeof session.id === 'string' ? session.id : undefined
        if (approvalStore !== null && typeof exec.callId === 'string' && exec.callId !== '' && sessionId !== undefined) {
          // cwd：真实来源是 `exec.agent.session.header.cwd`（dsh-tools:1423 同一取值路径；dsh-session:1044 保证
          // 为合法绝对路径）。exec 上**没有** cwd；exec.cwd 仅作镜像兜底，两者都没有 → 身份不完整（unsupported）。
          let cwd
          let cwdSource
          const headerCwd = session.header !== undefined && session.header !== null ? session.header.cwd : undefined
          if (typeof headerCwd === 'string' && headerCwd !== '') { cwd = headerCwd; cwdSource = 'agent.session.header.cwd' }
          else if (typeof exec.cwd === 'string' && exec.cwd !== '') { cwd = exec.cwd; cwdSource = 'exec.cwd' }
          // parent：官方真实字段（嵌套/PTC 派发时是父执行的 token；顶层通常没有）
          approvalStore.snapshotCall({
            sessionId, callId: exec.callId, rootCallId: exec.rootCallId, parent: exec.parent,
            name: exec.name, args: exec.arguments, cwd, cwdSource,
          })
        }
      } catch (e) {
        // 快照失败绝不影响工具执行链
        console.error('[dsh-bridge] approval snapshot failed:', errText(e).slice(0, 200))
      }
      return next()
    })
    return () => { if (typeof off === 'function') off() }
  })

  // 2) approval/request answerer：prepend 抢先注册；严格谓词不成立 → 立即 next()；
  //    内部异常 → next()（绝不 throw：官方 decide 把 throw 归一成 unavailable，会跳过人工链）。
  ctx.effect(() => {
    const off = ctx.on('approval/request', (req, next) => {
      try {
        return handleApprovalRequest(req).then(
          (outcome) => (typeof outcome === 'string' && outcome !== '' ? outcome : next()),
          (e) => {
            console.error('[dsh-bridge] approval answerer error → next():', errText(e).slice(0, 200))
            return next()
          },
        )
      } catch (e) {
        console.error('[dsh-bridge] approval answerer error → next():', errText(e).slice(0, 200))
        return next()
      }
    }, { prepend: true })
    return () => {
      // 卸载：把在途挂起项安全收口（绝不留下"可答但已无回调"的假状态）
      try {
        if (approvalStore !== null) approvalStore.closeLiveForTask(undefined, APPROVAL_STATES.SUPERSEDED, 'bridge plugin unloaded')
      } catch (e) { /* ignore */ }
      // 卸载后**零读取、零写盘**（第二次验收修正 3）：把所有观察记录标 settled 并立刻唤醒它们的等待，
      // 这样首循环、后台续证、显式查询续证都立即停手，也不再空转定时器。
      for (const record of Array.from(sessionTargets.values())) {
        try { settleReceiptRecord(record) } catch (e) { /* ignore */ }
      }
      if (typeof off === 'function') off()
    }
  })

  let sweeping = false
  if (timer !== undefined) {
    ctx.effect(() => timer.interval(() => {
      if (sweeping) return
      sweeping = true
      void (async () => {
        for (const bucket of buckets.values()) await pollOne(bucket)
        for (const bucket of reviewerBuckets.values()) await pollOne(bucket)
        await sweepSessionTargets()
        observations.prune()
      })().catch((e) => console.error('[dsh-bridge] observation failed:', errText(e).slice(0, 200))).finally(() => { sweeping = false })
    }, 2500))
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => {
      let total = 0
      for (const c of chunks) total += c.length
      const merged = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { merged.set(c, off); off += c.length }
      resolve(new TextDecoder().decode(merged))
    })
    req.on('error', reject)
  })
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readJsonBody = async (req, res) => {
    let body
    try { body = await readBody(req) } catch (e) { sendJson(res, 400, { error: errText(e) }); return null }
    try { return JSON.parse(body || '{}') } catch (e) { sendJson(res, 400, { error: 'invalid JSON' }); return null }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/task',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return }
      const parsed = await readJsonBody(req, res)
      if (parsed === null) return
      const instruction = parsed !== null && typeof parsed === 'object' && typeof parsed.instruction === 'string' ? parsed.instruction : ''
      const dryRun = parsed !== null && typeof parsed === 'object' && parsed.dryRun === true
      if (!dryRun && instruction.trim() === '') { sendJson(res, 400, { error: 'missing instruction' }); return }
      const classified = classifyTarget(parsed)
      if (!classified.ok) { sendJson(res, 400, { error: classified.message, reason: classified.reason }); return }
      // 来源关联（R1）：非法值在**外部执行前**拒绝；dryRun 不写任何关联。
      const origin = originOf(parsed)
      if (!origin.ok) {
        sendJson(res, 400, { error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', reason: ASSOC_REASONS.INVALID_ORIGIN })
        return
      }
      // 审批委托（M1/M2）：`delegate:true` 必须由控制凭据鉴权（loopback/origin/task 都只是定位，
      // 不自证授权）；worker 目标（child 身份未证明）、缺 key、缺来源一律在**发出 prompt 之前**拒绝
      // ——零执行，绝不出现"派活后才发现没接审批"。
      let delegateOptions
      if (parsed !== null && typeof parsed === 'object' && parsed.delegate === true) {
        const auth = approvalAuth(req)
        if (auth.ok !== true) {
          sendJson(res, 401, { error: 'delegated dispatch requires a valid control credential (initialize the control key first)', reason: auth.reason })
          return
        }
        if (origin.originThreadId === undefined) {
          sendJson(res, 400, { error: 'delegate requires originThreadId: the grant binds task + origin before anything is dispatched', reason: APPROVAL_REASONS.ORIGIN_REQUIRED })
          return
        }
        if (classified.target.kind !== 'session') {
          sendJson(res, 400, {
            error: 'approval delegation does not support worker targets (the executing child identity is unproven); dispatch without delegate to keep the legacy worker path',
            reason: APPROVAL_REASONS.UNSUPPORTED_TARGET,
          })
          return
        }
        delegateOptions = {
          ttlSec: typeof parsed.delegateTtlSec === 'number' && parsed.delegateTtlSec > 0 ? Math.min(parsed.delegateTtlSec, 3600) : undefined,
          leaseSec: typeof parsed.delegateLeaseSec === 'number' && parsed.delegateLeaseSec > 0 ? Math.min(parsed.delegateLeaseSec, 600) : undefined,
          // 授权说明/工作范围：由**可信发起端**在这次已认证的派活里给出，随 grant 固定记录并回给审批模型。
          authorization: typeof parsed.authorization === 'string' && parsed.authorization.trim() !== '' ? parsed.authorization.trim().slice(0, 500) : undefined,
          credDigest: auth.credDigest,
        }
      }

      // ---- 投递控制（第四轮）：steer 是"改动既有任务"的动作 → 必须有**认证发起端** + 显式父任务。
      // 队列（默认）对来源绑定任务不要求凭据（旧非委托 queue 行为不变）；新字段遇旧网关由客户端预检拒绝。
      let steering
      if (classified.deliver === 'steer' || (parsed !== null && typeof parsed === 'object' && (parsed.parentTaskId !== undefined || parsed.expectedTurn !== undefined))) {
        const auth = approvalAuth(req)
        if (auth.ok !== true) {
          sendJson(res, 401, { error: 'steer modifies an existing task and requires a valid control credential on the requesting client', reason: auth.reason })
          return
        }
        const parentTaskId = parsed !== null && typeof parsed === 'object' && typeof parsed.parentTaskId === 'string' && parsed.parentTaskId.trim() !== '' ? parsed.parentTaskId.trim() : undefined
        if (classified.deliver !== 'steer' && parentTaskId !== undefined) {
          sendJson(res, 400, { error: 'parentTaskId is only valid with deliver="steer"', reason: REASONS.PARENT_REQUIRED })
          return
        }
        steering = {
          parentTaskId,
          expectedTurn: parsed !== null && typeof parsed === 'object' && Number.isInteger(parsed.expectedTurn) ? parsed.expectedTurn : undefined,
        }
      }
      // dryRun：只解析目标、回显它，**不投递任何东西**。存在的意义是让"我这条查询会命中
      // 哪条会话"能纯只读地问出来——真实事故里调用方就是因为没法先验证，才发了一条占位
      // 消息去探测，结果污染了用户会话。
      if (dryRun) {
        if (classified.target.kind === 'session') {
          const resolved = await resolveSessionTarget(classified.target)
          if (!resolved.ok) {
            sendJson(res, 200, {
              dryRun: true,
              resolved: false,
              reason: resolved.reason,
              error: resolved.message,
              ...(Array.isArray(resolved.candidates) && resolved.candidates.length > 0 ? { candidates: resolved.candidates } : {}),
            })
            return
          }
          sendJson(res, 200, {
            dryRun: true,
            resolved: true,
            wouldDispatch: true,
            target: { kind: 'session', sessionId: resolved.sessionId, deliver: classified.deliver },
            ...(resolved.snippet === undefined ? {} : { snippet: resolved.snippet }),
            ...(resolved.matchedBy === undefined ? {} : { matchedBy: resolved.matchedBy }),
            ...(resolved.candidates.length > 0 ? { candidates: resolved.candidates } : {}),
            note: '只解析目标，未投递任何消息',
          })
          return
        }
        const cwd = normalizeCwd(classified.target.cwd)
        const lane = normalizeLane(classified.target.lane)
        sendJson(res, 200, {
          dryRun: true,
          resolved: true,
          wouldDispatch: true,
          target: { kind: 'worker', cwd, lane },
          note: '只解析目标，未派活',
        })
        return
      }
      const routePolicy = parseRoutePolicy(parsed)
      const task = await enqueue(instruction, parsed.history, classified.target, parsed.model, 'task', classified.deliver, classified.notes, origin.originThreadId, delegateOptions, steering, routePolicy)
      if (task.status === 'error') {
        sendJson(res, 400, {
          error: task.error,
          reason: task.reason,
          ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }),
          ...(task.delivered === true ? { delivered: true } : {}),
          ...(task.route === undefined ? {} : { route: task.route }),
          ...(Array.isArray(task.candidates) && task.candidates.length > 0 ? { candidates: task.candidates } : {}),
        })
        return
      }
      sendJson(res, 202, {
        ...taskResponse(task),
        ...(task.route === undefined ? {} : { route: task.route }),
        model: classified.target.kind === 'worker' ? (parsed.model || null) : null,
      })
    },
  }))

  // 只读模型目录（M2）：`GET /api/dsh-bridge/models` —— 不激活任何会话、不发起模型请求、不显示凭据/endpoint。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/models',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405); res.end('GET or POST only'); return }
      try {
        const query = req.method === 'POST' ? ((await readJsonBody(req, res)) || {}) : qsOf(req)
        const view = await modelRouting.modelsView({ force: query.force === true || query.force === 'true' })
        sendJson(res, 200, {
          ...view,
          status: modelRouting.status().counters,
          limits: modelRouting.limits,
          routing: capabilityReport().modelRouting,
        })
      } catch (e) {
        sendJson(res, 502, { ok: false, error: 'model catalog query failed', reason: 'model-catalog-failed', detail: errText(e).slice(0, 200) })
      }
    },
  }))

  // 只读"找到会话"：不创建、不投递、不激活 Agent（search/附件/历史页都不激活）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/sessions',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      if (req.method !== 'POST' && req.method !== 'GET') { res.writeHead(405); res.end('POST or GET only'); return }
      let parsed = {}
      if (req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === null) return
        parsed = body
      } else {
        parsed = qsOf(req)
      }
      const controller = sessionControllerNow()
      if (controller === undefined) {
        sendJson(res, 503, { error: 'sessionController service is not mounted yet (it registers asynchronously after startup; retry shortly)', reason: REASONS.CONTROLLER_UNAVAILABLE })
        return
      }
      const query = typeof parsed.query === 'string' && parsed.query.trim() !== '' ? parsed.query.trim() : undefined
      const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim() !== '' ? parsed.sessionId.trim() : undefined
      // create 是显式动作：为探针/一次性任务建一条空白会话，不去碰任何已有会话。
      if (parsed.create === true) {
        const cwd = typeof parsed.cwd === 'string' && parsed.cwd.trim() !== '' ? parsed.cwd.trim() : undefined
        try {
          const created = await controller.create(cwd === undefined ? {} : { cwd }, signalOf())
          sendJson(res, 201, { sessionId: created !== undefined && created !== null ? created.sessionId : undefined, agentPreset: created === undefined || created === null ? undefined : created.agentPreset })
        } catch (e) {
          sendJson(res, 502, { error: errText(e), reason: mapControllerError(e) })
        }
        return
      }
      if (query === undefined && sessionId === undefined) {
        sendJson(res, 400, { error: 'query or sessionId required', reason: REASONS.INVALID_TARGET })
        return
      }
      const limit = Math.min(Math.max(Number(parsed.limit) || 10, 1), 50)
      try {
        if (sessionId !== undefined) {
          const resolved = await resolveSessionTarget({ kind: 'session', sessionId })
          if (!resolved.ok) {
            sendJson(res, 404, { error: resolved.message, reason: resolved.reason, candidates: resolved.candidates })
            return
          }
          sendJson(res, 200, { items: [{ sessionId: resolved.sessionId, ...(resolved.snippet === undefined ? {} : { snippet: resolved.snippet }), agentAvailable: true }], hasMore: false })
          return
        }
        // search 失败就退回 list：有些部署把 session-query 索引配成 openAt "never"。
        const found = await sessionFind(query)
        const hits = found.hits
        const items = hits.slice(0, limit).map((h) => ({
          sessionId: h.sessionId,
          snippet: typeof h.snippet === 'string' ? h.snippet.slice(0, 200) : '',
        }))
        if (parsed.inspect === true) {
          // 只对前 5 条探能力：逐条 stat 会很贵，这里保持有界。
          for (const item of items.slice(0, 5)) {
            try {
              const r = await controller.resolveAgent(item.sessionId)
              const failed = r !== undefined && r !== null && r.error !== undefined
              item.agentAvailable = !failed
              if (failed) item.problem = mapControllerError(r.error)
            } catch (e) {
              item.agentAvailable = false
              item.problem = mapControllerError(e)
            }
          }
        }
        // 没命中不是死路：给近似候选（同一批只读数据，按相似度 + 最近更新排序），
        // 让调用方改词重查——而不是发一条消息去"探测命中"。
        const candidates = hits.length === 0 ? await sessionNearMisses(query, limit) : []
        sendJson(res, 200, {
          items,
          hasMore: hits.length > items.length,
          total: hits.length,
          matchedBy: found.matchedBy,
          ...(candidates.length > 0
            ? { candidates, reason: REASONS.QUERY_EMPTY, note: '标题/目录里都没有这个关键词；candidates 是按相似度与最近更新排的候选，改词重查或直接用 sessionId' }
            : {}),
        })
      } catch (e) {
        sendJson(res, 502, { error: errText(e), reason: mapControllerError(e) })
      }
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/review',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return }
      const parsed = await readJsonBody(req, res)
      if (parsed === null) return
      const origin = originOf(parsed)
      if (!origin.ok) {
        sendJson(res, 400, { error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', reason: ASSOC_REASONS.INVALID_ORIGIN })
        return
      }
      const task = await submitReview(parsed.cwd, parsed.diff, parsed.focus, parsed.history, origin.originThreadId, parseRoutePolicy(parsed))
      if (task.status === 'error') {
        sendJson(res, 400, {
          error: task.error, reason: task.reason,
          ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }),
          ...(task.route === undefined ? {} : { route: task.route }),
          ...(Array.isArray(task.candidates) && task.candidates.length > 0 ? { candidates: task.candidates } : {}),
        })
        return
      }
      sendJson(res, 202, {
        taskId: task.taskId, status: task.status, cwd: task.cwd, kind: 'review',
        ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }),
        ...(task.route === undefined ? {} : { route: task.route }),
      })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/tasks',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const qs = qsOf(req)
      const origin = originOf(qs)
      if (!origin.ok) {
        sendJson(res, 400, { error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', reason: ASSOC_REASONS.INVALID_ORIGIN })
        return
      }
      const projection = (t) => ({ taskId: t.taskId, kind: t.kind, cwd: t.cwd, lane: t.lane, target: t.target, deliver: t.deliver, status: t.status, time: t.time, instruction: t.instruction.slice(0, 200), error: t.error, reason: t.reason, fallback: t.fallback, ...(t.originThreadId === undefined ? {} : { originThreadId: t.originThreadId }) })
      // 带 originThreadId：跨回合按来源找任务（含只存在于持久记录里的历史任务）。
      if (origin.originThreadId !== undefined) {
        const live = tasks.filter((t) => t.originThreadId === origin.originThreadId)
        const liveIds = new Set(live.map((t) => t.taskId))
        const listed = associations === null ? { ok: false, reason: 'association-store-unavailable' } : associations.byOrigin(origin.originThreadId)
        if (listed.ok !== true) {
          sendJson(res, 503, { error: 'task association store is unavailable in this gateway', reason: listed.reason })
          return
        }
        const byId = new Map(listed.tasks.map((r) => [r.taskId, r]))
        const merged = [
          ...live.map((t) => ({ ...projectStoredTask(byId.get(t.taskId) === undefined ? { taskId: t.taskId, originThreadId: t.originThreadId, kind: t.kind, target: t.target, status: t.status, createdAt: t.time, updatedAt: t.time } : byId.get(t.taskId)), instruction: t.instruction.slice(0, 200), live: true })),
          ...listed.tasks.filter((r) => !liveIds.has(r.taskId)).map((r) => projectStoredTask(r)),
        ]
        sendJson(res, 200, { originThreadId: origin.originThreadId, count: merged.length, tasks: merged, recovered: listed.tasks.some((r) => !liveIds.has(r.taskId)), live: live.length, capabilities: capabilityReport() })
        return
      }
      sendJson(res, 200, { tasks: tasks.slice(-50).map(projection), capabilities: capabilityReport() })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/cancel',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const parsed = await readJsonBody(req, res)
      if (parsed === null) return
      const taskId = parsed && parsed.taskId
      if (typeof taskId !== 'string' || taskId === '') { sendJson(res, 400, { error: 'missing taskId' }); return }
      const origin = originOf(parsed)
      if (!origin.ok) {
        sendJson(res, 400, { error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', reason: ASSOC_REASONS.INVALID_ORIGIN })
        return
      }
      const task = tasks.find((t) => t.taskId === taskId)
      if (task === undefined) { sendJson(res, 404, { error: 'unknown taskId' }); return }
      // 已关联的任务：缺来源/错来源都拒绝（同一个入口规则与 /status 一致）。
      if (task.originThreadId !== undefined) {
        if (origin.originThreadId === undefined) {
          sendJson(res, 404, {
            error: 'task ' + taskId + ' is bound to a source conversation; pass originThreadId to cancel it',
            reason: ASSOC_REASONS.MISSING_ORIGIN,
            hint: 'pass originThreadId (the Codex conversation that dispatched this task)',
          })
          return
        }
        if (task.originThreadId !== origin.originThreadId) {
          sendJson(res, 404, { error: 'task ' + taskId + ' is bound to another origin', reason: ASSOC_REASONS.ORIGIN_MISMATCH })
          return
        }
      }
      // 投递控制（第四轮 D1）取消安全：
      //  * steer 回执：取消回执 ≠ 取消父任务，且回执本身没有可撤回的官方入口 → 明确拒绝；
      //  * queued 项：无法证明"逐项撤回"（官方只有 session 级 clear/cancel）→ 明确拒绝，绝不 cancel 整个会话去清队列。
      if (task.deliver === 'steer' || task.status === 'queued') {
        sendJson(res, 409, {
          taskId,
          cancelled: false,
          reason: 'cancel-unsupported-for-queued',
          error: task.deliver === 'steer'
            ? 'cancelling a steer receipt is not supported: it is not the parent task, and the official API has no per-message retraction. Cancel the parent (if it is yours) or wait for it to finish.'
            : 'cancelling a queued task is not supported: the official API only offers session-level cancel, which would also kill other tasks/queued items. Wait for it to run, or cancel the running task explicitly when it is the only one.',
        })
        return
      }
      if (task.status !== 'accepted' && task.status !== 'running') { sendJson(res, 200, { taskId, cancelled: false, status: task.status, ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }) }); return }

      // session 目标动的是用户自己的对话：取消会打断他正在跑的回合，因此必须显式 force。
      if (task.target !== undefined && task.target.kind === 'session') {
        // 多任务安全（第四轮 D1）：session cancel 会清掉整队列——只有"本会话没有别的在途任务"时才允许。
        const others = sessionRecords(task.target.sessionId).filter((r) => r.taskId !== task.taskId)
        if (others.length > 0) {
          sendJson(res, 409, {
            taskId,
            cancelled: false,
            reason: 'cancel-unsafe-with-other-tasks',
            error: 'this session has ' + others.length + ' other in-flight/queued bridge task(s) (' + others.map((r) => r.taskId).join(', ') + '); a session-level cancel would kill them too, so cancelling this task is refused. Wait for them to finish or settle them first.',
            otherTaskIds: others.map((r) => r.taskId),
          })
          return
        }
        if (parsed.force !== true) {
          sendJson(res, 409, {
            taskId,
            cancelled: false,
            reason: REASONS.CANCEL_REFUSED,
            error: 'cancelling a session-target task interrupts the user\'s own turn; pass force: true to do it deliberately',
          })
          return
        }
        let cancelled = false
        try {
          const controller = sessionControllerNow()
          if (controller === undefined) throw new Error('sessionController service is not mounted in this profile')
          await controller.cancel({ sessionId: task.target.sessionId }, signalOf())
          cancelled = true
        } catch (e) {
          console.error('[dsh-bridge] session cancel failed:', errText(e).slice(0, 200))
        }
        task.status = 'cancelled'
        task.cancelReason = 'cancelled by request (force)'
        const record = recordForTask(taskId)
        if (record !== undefined) settleSessionTask(record, 'cancelled', {})
        persistTask(task)
        pushTask(taskId, 'cancelled', { target: { kind: 'session', sessionId: task.target.sessionId } })
        sendJson(res, 200, { taskId, cancelled: true, interrupted: cancelled, target: task.target, ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }) })
        return
      }

      task.status = 'cancelled'
      task.cancelReason = 'cancelled by request'
      let interrupted = false
      try {
        const bucket = buckets.get(task.bucketKey) || reviewerBuckets.get(task.cwd)
        if (bucket !== undefined && bucket.childId !== null && bucket.agent !== null) {
          subagents.interrupt(bucket.childId, bucket.agent)
          interrupted = true
        }
      } catch (e) {
        console.error('[dsh-bridge] cancel interrupt failed:', errText(e).slice(0, 200))
      }
      persistTask(task)
      pushTask(taskId, 'cancelled', { cwd: task.cwd })
      sendJson(res, 200, { taskId, cancelled: true, interrupted, ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }) })
    },
  }))

  // ================================================================ 审批 HTTP（全部鉴权：私有 raw key）
  // 边界：origin/task 只负责定位且**必须显式给出**（修正 D：空过滤不再顺手续所有任务租约、
  // 不跨来源泄露）；真正的授权校验在 store.decide 里按 pending/grant 硬核对；
  // 响应从不回显收到的头、raw key 或任何授权摘要；决定请求**不接受**任何参数副本。
  const approvalCtx = (src, required = {}) => {
    const origin = originOf(src)
    if (!origin.ok || origin.originThreadId === undefined) {
      return { ok: false, status: 400, reason: ASSOC_REASONS.INVALID_ORIGIN, error: 'originThreadId is required (a non-empty string) — it locates the task; it never authorizes by itself' }
    }
    const taskId = typeof src.taskId === 'string' ? src.taskId.trim() : ''
    if (taskId === '') {
      return { ok: false, status: 400, reason: APPROVAL_REASONS.TASK_REQUIRED, error: 'taskId is required together with originThreadId' }
    }
    const out = { ok: true, originThreadId: origin.originThreadId, taskId }
    for (const key of ['grantId', 'approvalKey', 'sessionId']) {
      if (required[key] === true) {
        const value = typeof src[key] === 'string' ? src[key].trim() : ''
        if (value === '') return { ok: false, status: 400, reason: 'bad-input', error: key + ' is required' }
        out[key] = value
      } else if (typeof src[key] === 'string' && src[key].trim() !== '') {
        out[key] = src[key].trim()
      }
    }
    return out
  }

  const ensureGrantView = (grant, credDigest) => (grant !== undefined && grant !== null && grant.credDigest === credDigest)

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/dsh-bridge/approvals',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const auth = approvalAuth(req)
      if (auth.ok !== true) {
        sendJson(res, 401, { ok: false, error: 'a valid control credential is required for approval operations', reason: auth.reason })
        return
      }
      if (approvalStore === null) { sendJson(res, 503, { ok: false, error: 'approval store unavailable' }); return }
      if (approvalStore.grantLogHealthy() !== true) {
        // 权限记录受损 → 安全失败（不基于受损记录做任何判断）
        sendJson(res, 503, { ok: false, error: 'authorization records are damaged; refusing to act until repaired', reason: APPROVAL_REASONS.GRANT_LOG_CORRUPT })
        return
      }
      const credDigest = auth.credDigest
      const url = new URL(req.url, 'http://127.0.0.1')
      const sub = url.pathname.slice('/api/dsh-bridge/approvals'.length)
      const now = Date.now()

      // ---- 清单（必须显式 origin+task；续租/续期只作用于本次查询显式命中的 grant）
      if (sub === '' || sub === '/') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET required' }); return }
        const qs = qsOf(req)
        const scope = approvalCtx(qs)
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const extendSec = Number(qs.extendSec)
        const renew = qs.renew === '1' || qs.renew === 'true'
        const grantFilter = { originThreadId: scope.originThreadId, taskId: scope.taskId }
        if (scope.grantId !== undefined) grantFilter.grantId = scope.grantId
        if (scope.sessionId !== undefined) grantFilter.sessionId = scope.sessionId
        const scoped = approvalStore.listGrants(grantFilter).filter((g) => ensureGrantView(g, credDigest))
        const renewed = []
        const extended = []
        for (const g of scoped) {
          if (g.status !== 'active' || now > g.expiresAt) continue
          const r = approvalStore.renewLease({ grantId: g.grantId, taskId: g.taskId, originThreadId: g.originThreadId, sessionId: g.scope.sessionId, credDigest, now })
          if (r.ok === true) renewed.push(g.grantId)
          if (renew) {
            const e = approvalStore.renewGrant({ grantId: g.grantId, taskId: g.taskId, originThreadId: g.originThreadId, sessionId: g.scope.sessionId, credDigest, extendSec: Number.isFinite(extendSec) && extendSec > 0 ? extendSec : undefined, now })
            if (e.ok === true) extended.push({ grantId: g.grantId, expiresAt: e.grant.expiresAt, leaseUntil: e.grant.leaseUntil, cap: e.cap })
          }
        }
        const pendings = approvalStore.listPending({
          originThreadId: scope.originThreadId, taskId: scope.taskId,
          ...(scope.grantId === undefined ? {} : { grantId: scope.grantId }),
          ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
        }).filter((p) => ensureGrantView(approvalStore.getGrant(p.grantId), credDigest))
        sendJson(res, 200, {
          ok: true,
          now,
          renewHint: 'authenticated list/detail/decide calls renew the lease; pass renew=1 (or the /renew route) to extend the absolute grant TTL inside the authorized window',
          renewedGrants: renewed,
          extendedGrants: extended,
          grants: scoped.map((g) => ({
            grantId: g.grantId, version: g.version, status: g.status, taskId: g.taskId,
            originThreadId: g.originThreadId, sessionId: g.scope.sessionId,
            authorization: g.authorization,
            issuedAt: g.issuedAt, expiresAt: g.expiresAt, leaseUntil: g.leaseUntil,
            ...(g.revokedAt === undefined ? {} : { revokedAt: g.revokedAt, revokeReason: g.revokeReason }),
          })),
          approvals: pendings.map((p) => approvalStore.pendingView(p)),
          unanswerable: approvalStore.unansweredFromAudit()
            .filter((u) => u.originThreadId === undefined || (u.originThreadId === scope.originThreadId && (u.taskId === undefined || u.taskId === scope.taskId))),
        })
        return
      }

      // ---- 为**已存在且已绑定来源**的任务显式启用委托（不再允许给 unbound 任务随意声明 origin）
      if (sub === '/enable') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return }
        const body = await readJsonBody(req, res)
        if (body === null) return
        const scope = approvalCtx(body, { sessionId: true })
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const task = tasks.find((t) => t.taskId === scope.taskId)
        if (task === undefined) {
          sendJson(res, 404, { ok: false, error: 'unknown task in this gateway (enable cannot invent a binding)', reason: 'task-not-found' })
          return
        }
        if (task.target === undefined || task.target.kind !== 'session' || task.target.sessionId !== scope.sessionId) {
          sendJson(res, 400, { ok: false, error: 'the grant scope must equal the task session target', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH })
          return
        }
        if (task.originThreadId === undefined) {
          sendJson(res, 400, { ok: false, error: 'this task has no source binding; delegation requires a task that was dispatched with originThreadId', reason: APPROVAL_REASONS.ORIGIN_REQUIRED })
          return
        }
        if (task.originThreadId !== scope.originThreadId) {
          sendJson(res, 403, { ok: false, error: 'task is bound to another source conversation', reason: APPROVAL_REASONS.ORIGIN_MISMATCH })
          return
        }
        const existing = approvalStore.listGrants({ originThreadId: scope.originThreadId, taskId: scope.taskId, sessionId: scope.sessionId, activeOnly: true })
          .find((g) => ensureGrantView(g, credDigest) && g.expiresAt > now)
        if (existing !== undefined) {
          sendJson(res, 200, { ok: true, reused: true, grantId: existing.grantId, version: existing.version, expiresAt: existing.expiresAt, leaseUntil: existing.leaseUntil, taskId: scope.taskId, originThreadId: scope.originThreadId, sessionId: scope.sessionId, authorization: existing.authorization })
          return
        }
        try {
          const grant = approvalStore.issueGrant({
            originThreadId: scope.originThreadId,
            taskId: scope.taskId,
            scope: { kind: 'session', sessionId: scope.sessionId },
            ttlMs: typeof body.ttlSec === 'number' && body.ttlSec > 0 ? Math.min(body.ttlSec, 3600) * 1000 : undefined,
            leaseMs: typeof body.leaseSec === 'number' && body.leaseSec > 0 ? Math.min(body.leaseSec, 600) * 1000 : undefined,
            credDigest,
            authorization: typeof body.authorization === 'string' ? body.authorization : undefined,
          })
          approvalStore.audit({ type: 'grant', phase: 'issued', grantId: grant.grantId, taskId: scope.taskId, originThreadId: scope.originThreadId, sessionId: scope.sessionId, authorization: grant.authorization, how: 'enable-route' })
          sendJson(res, 200, { ok: true, grantId: grant.grantId, version: grant.version, expiresAt: grant.expiresAt, leaseUntil: grant.leaseUntil, taskId: scope.taskId, originThreadId: scope.originThreadId, sessionId: scope.sessionId, authorization: grant.authorization })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: errText(e), reason: 'grant-issue-failed' })
        }
        return
      }

      // ---- 撤销（立刻失效，含在途 pending 收口）
      const revokeMatch = /^\/grants\/([A-Za-z0-9-]+)\/revoke$/.exec(sub)
      if (revokeMatch !== null) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return }
        const body = await readJsonBody(req, res)
        if (body === null) return
        const scope = approvalCtx(body, { grantId: true })
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const grantId = revokeMatch[1]
        if (grantId !== scope.grantId) { sendJson(res, 400, { ok: false, error: 'grantId must match the route', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH }); return }
        const grant = approvalStore.getGrant(grantId)
        if (grant === undefined || !ensureGrantView(grant, credDigest)) {
          sendJson(res, 404, { ok: false, error: 'grant not found for this credential', reason: APPROVAL_REASONS.GRANT_MISSING })
          return
        }
        if (grant.taskId !== scope.taskId || grant.originThreadId !== scope.originThreadId) {
          sendJson(res, 403, { ok: false, error: 'grant belongs to another task/source', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH })
          return
        }
        const result = approvalStore.revokeGrant(grantId, typeof body.reason === 'string' ? body.reason : 'revoked via route')
        approvalStore.audit({ type: 'grant', phase: 'revoked', grantId, taskId: grant.taskId, originThreadId: grant.originThreadId, reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'revoked via route' })
        sendJson(res, 200, { ok: result.ok === true, grantId, status: 'revoked', ...(result.reason === undefined ? {} : { reason: result.reason }) })
        return
      }

      // ---- 认证续期（在原授权窗口内显式延长绝对 TTL；不靠后台无限续租）
      const renewMatch = /^\/grants\/([A-Za-z0-9-]+)\/renew$/.exec(sub)
      if (renewMatch !== null) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return }
        const body = await readJsonBody(req, res)
        if (body === null) return
        const scope = approvalCtx(body, { grantId: true })
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const grantId = renewMatch[1]
        if (grantId !== scope.grantId) { sendJson(res, 400, { ok: false, error: 'grantId must match the route', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH }); return }
        const grant = approvalStore.getGrant(grantId)
        if (grant === undefined || !ensureGrantView(grant, credDigest)) {
          sendJson(res, 404, { ok: false, error: 'grant not found for this credential', reason: APPROVAL_REASONS.GRANT_MISSING })
          return
        }
        const result = approvalStore.renewGrant({
          grantId, taskId: scope.taskId, originThreadId: scope.originThreadId, sessionId: grant.scope.sessionId, credDigest,
          extendSec: typeof body.extendSec === 'number' && body.extendSec > 0 ? Math.min(body.extendSec, 3600) : undefined,
          now,
        })
        if (result.ok !== true) { sendJson(res, 409, { ok: false, reason: result.reason }); return }
        approvalStore.audit({ type: 'grant', phase: 'renewed', grantId, taskId: grant.taskId, originThreadId: grant.originThreadId, expiresAt: result.grant.expiresAt })
        sendJson(res, 200, { ok: true, grantId, expiresAt: result.grant.expiresAt, leaseUntil: result.grant.leaseUntil, cap: result.cap })
        return
      }

      // ---- 决定（严格入参；身份/版本/指纹/上下文由 store.decide 硬核对）
      const decideMatch = /^\/([A-Za-z0-9-]+)\/decide$/.exec(sub)
      if (decideMatch !== null) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return }
        const body = await readJsonBody(req, res)
        if (body === null) return
        const allowedKeys = new Set(['originThreadId', 'taskId', 'grantId', 'grantVersion', 'fingerprint', 'decision', 'idempotencyKey'])
        const extra = Object.keys(body).filter((k) => !allowedKeys.has(k))
        if (extra.length > 0) {
          // 参数副本/歧义入参一律拒绝（绝不"默默接受后按原命令批准"）
          sendJson(res, 400, { ok: false, error: 'unexpected fields are not accepted on a decision: ' + extra.join(','), reason: APPROVAL_REASONS.EXTRA_FIELDS })
          return
        }
        const scope = approvalCtx(body, { grantId: true })
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const approvalKey = decideMatch[1]
        const pending = approvalStore.getPending(approvalKey)
        if (pending === undefined) {
          sendJson(res, 404, { ok: false, error: 'no live approval with that key (a restart loses live callbacks; wait for a fresh request)', reason: APPROVAL_REASONS.PENDING_MISSING })
          return
        }
        if (pending.grantId !== scope.grantId || pending.taskId !== scope.taskId || pending.originThreadId !== scope.originThreadId) {
          sendJson(res, 403, { ok: false, error: 'this approval belongs to another task/source/grant', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH })
          return
        }
        if (body.decision !== DECISIONS.APPROVE_ONCE && body.decision !== DECISIONS.REJECT) {
          sendJson(res, 400, { ok: false, error: 'decision must be approve-once or reject', reason: 'unknown-decision' })
          return
        }
        if (typeof body.fingerprint !== 'string' || body.fingerprint === '') {
          sendJson(res, 400, { ok: false, error: 'fingerprint is required (from GET /approvals/<key>)', reason: APPROVAL_REASONS.FINGERPRINT_MISMATCH })
          return
        }
        // 认证 + 匹配该委托 → 续租（这是"活跃 RPC 有界续租"的唯一途径）
        approvalStore.renewLease({ grantId: pending.grantId, taskId: pending.taskId, originThreadId: pending.originThreadId, sessionId: pending.sessionId, credDigest, now })
        // 当前 turn/step 必须由**日志实时**给出：只比 coarse snapshotId 会漏掉 step-only 变化（root 复现）。
        // 日志不可读/无 tool/call → 身份不可证明 → 明确拒绝（绝不当作可放行）。
        const decideEvents = await readSessionEvents(pending.sessionId)
        const live = approvalStore.getSnapshot(pending.sessionId, pending.callId)
        const currentTurnStep = decideEvents === null ? null : resolveTurnStepFrom(decideEvents, pending.callId)
        if (currentTurnStep === null) {
          sendJson(res, 409, {
            ok: false,
            reason: APPROVAL_REASONS.IDENTITY_UNKNOWN,
            error: 'the current execution identity cannot be proven right now (session log unreadable or no tool/call for this callId); refusing the decision instead of guessing',
          })
          return
        }
        const result = approvalStore.decide({
          approvalKey,
          fingerprint: body.fingerprint,
          decision: body.decision,
          idempotencyKey: typeof body.idempotencyKey === 'string' && body.idempotencyKey !== '' ? body.idempotencyKey.slice(0, 120) : undefined,
          credDigest,
          originThreadId: scope.originThreadId,
          taskId: scope.taskId,
          grantVersion: typeof body.grantVersion === 'number' ? body.grantVersion : undefined,
          currentSnapshotId: live === undefined ? undefined : live.snapshotId,
          currentTurnStep,
          now,
        })
        if (result.ok !== true) {
          sendJson(res, 409, { ok: false, reason: result.reason, ...(result.state === undefined ? {} : { state: result.state }) })
          return
        }
        sendJson(res, 200, {
          ok: true,
          phase: 'submitted',
          state: result.state,
          outcome: result.outcome,
          approvalKey,
          ...(result.idempotent === true ? { idempotent: true } : {}),
          confirmationHint: body.decision === DECISIONS.REJECT
            ? '提交 ≠ 终态：reject 的官方终态是 rejected（approval/decided, outcome=rejected）；轮询该审批看到 state=rejected 即已收敛，不要去等只对批准有意义的 confirmed'
            : 'submitted ≠ confirmed: re-query this approval; state=confirmed means the official approval/decided was observed with allowed-once, decision-unknown means confirmation was lost (do not re-send)',
        })
        return
      }

      // ---- 详情（鉴权 + origin/task 硬核对 + 续租）
      const detailMatch = /^\/([A-Za-z0-9-]+)$/.exec(sub)
      if (detailMatch !== null) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET required' }); return }
        const scope = approvalCtx(qsOf(req))
        if (scope.ok !== true) { sendJson(res, scope.status, { ok: false, error: scope.error, reason: scope.reason }); return }
        const pending = approvalStore.getPending(detailMatch[1])
        if (pending === undefined) {
          sendJson(res, 404, { ok: false, error: 'no live approval with that key', reason: APPROVAL_REASONS.PENDING_MISSING })
          return
        }
        const g = approvalStore.getGrant(pending.grantId)
        if (!ensureGrantView(g, credDigest) || pending.taskId !== scope.taskId || pending.originThreadId !== scope.originThreadId) {
          sendJson(res, 403, { ok: false, error: 'this approval is not visible for this credential/task/source', reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH })
          return
        }
        approvalStore.renewLease({ grantId: g.grantId, taskId: g.taskId, originThreadId: g.originThreadId, sessionId: g.scope.sessionId, credDigest, now })
        sendJson(res, 200, { ok: true, approval: approvalStore.pendingView(pending) })
        return
      }

      sendJson(res, 404, { ok: false, error: 'unknown approval route' })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const qs = qsOf(req)
      const origin = originOf(qs)
      if (!origin.ok) {
        sendJson(res, 400, { error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', reason: ASSOC_REASONS.INVALID_ORIGIN })
        return
      }
      const taskId = qs.taskId
      if (taskId !== undefined && taskId !== '') {
        const task = tasks.find((t) => t.taskId === taskId)
        if (task !== undefined) {
          // 已关联的任务：缺来源 → origin-required；错来源 → origin-mismatch。两条都**不返回结果**。
          // 只有旧的"未关联"任务才继续支持只按 taskId 查询（兼容）。
          if (task.originThreadId !== undefined) {
            if (origin.originThreadId === undefined) {
              sendJson(res, 404, {
                error: 'task ' + taskId + ' is bound to a source conversation; pass originThreadId to read it',
                reason: ASSOC_REASONS.MISSING_ORIGIN,
                hint: 'pass originThreadId (the Codex conversation that dispatched this task)',
              })
              return
            }
            if (task.originThreadId !== origin.originThreadId) {
              sendJson(res, 404, { error: 'task ' + taskId + ' is bound to another origin', reason: ASSOC_REASONS.ORIGIN_MISMATCH })
              return
            }
          }
          const record = recordForTask(task.taskId)
          // 回执：**每次显式查询都是一次官方证据机会**（第四轮首次验收修正 C）——长工具结束后
          // 同一父回合里的迟到 rpc 不会因为"单次等待窗口已过"而永久停留在未确认。
          if (record !== undefined && record.receipt === true) await refreshReceiptNow(record, task)          // 委托等待循环需要**当前**的 grant 定位/租约（第三轮修正 A）：每次 status 都从存储刷新，
          // 这样客户端能按真实 lease 剩余时间自适应续租（固定 10s 会放过 1–5s 的短租约）。
          const grantView = delegatedGrantView(task)
          sendJson(res, 200, {
            taskId: task.taskId, status: task.status, kind: task.kind, cwd: task.cwd, lane: task.lane,
            target: task.target, deliver: task.deliver, instruction: task.instruction.slice(0, 300),
            result: task.result, error: task.error, reason: task.reason, fallback: task.fallback,
            // delivered=true 表示 prompt 已被会话接受（进了队列）——即便后面报错也不要重发。
            ...(task.delivered === undefined ? {} : { delivered: task.delivered }),
            ...(grantView === null ? {} : { grantId: grantView.grantId, grantStatus: grantView.status, grantExpiresAt: grantView.expiresAt, grantLeaseUntil: grantView.leaseUntil }),
            // 投递控制（第四轮）：排队任务与补充回执的真实状态（重启后也能查）
            ...(task.requestedMode === undefined && task.deliver === undefined ? {} : { deliver: task.requestedMode !== undefined ? task.requestedMode : task.deliver }),
            ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
            ...(task.receiptState === undefined ? {} : { receiptState: task.receiptState }),
            ...(Number.isInteger(task.observedTurn) ? { observedTurn: task.observedTurn } : {}),
            ...(task.resultScope === undefined ? {} : { resultScope: task.resultScope }),
            // 动态模型路由（M2）：真实选择 + 切换次数/原因 + **跨重启可查**的审计尾部（只有稳定 code，无正文）
            ...(task.route === undefined ? {} : { route: task.route }),
            ...(task.routeStopReason === undefined ? {} : { routeStopReason: task.routeStopReason }),
            routeAudit: readRouteAudit(task.taskId, 20),
            routeAuditWindow: { maxBytes: 1024 * 1024, truncated: routeAuditReader.status().truncated },
            ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }),
            ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
            ...(task.dshTurn === undefined ? {} : { dshTurn: task.dshTurn }),
            ...(task.turnEndKind === undefined ? {} : { turnEndKind: task.turnEndKind }),
            ...(task.partialResult === undefined ? {} : { partialResult: task.partialResult }),
            ...(task.resend === undefined ? {} : { resend: task.resend }),
            ...(task.note === undefined ? {} : { note: task.note }),
            ...(task.associationError === undefined ? {} : { associationError: task.associationError }),
            ...(task.matchedBy === undefined ? {} : { matchedBy: task.matchedBy }),
            ...(Array.isArray(task.candidates) && task.candidates.length > 0 ? { candidates: task.candidates } : {}),
            // 审批等待态：非终态；只回非敏感能力/计数（approvalKey 等正文必须走鉴权审批接口取）。
            ...(task.status === 'needs-approval' || Array.isArray(task.approvalKeys)
              ? { needsApproval: task.status === 'needs-approval', approvalPendingCount: typeof task.approvalPendingCount === 'number' ? task.approvalPendingCount : 0, approvalsPath: '/api/dsh-bridge/approvals' }
              : {}),
            ...(record === undefined ? {} : { watcher: record.watcher, sawRunning: record.sawRunning }),
          })
          return
        }

        // 内存里没有（网关重载/新实例）：从持久关联记录恢复。
        const stored = associations === null
          ? { ok: false, reason: 'association-store-unavailable' }
          : associations.fetch({ originThreadId: origin.originThreadId, taskId })
        if (stored.ok !== true) {
          const hint = stored.reason === ASSOC_REASONS.MISSING_ORIGIN
            ? 'pass originThreadId to recover a persisted task result'
            : (stored.reason === ASSOC_REASONS.ORIGIN_MISMATCH ? 'this task is bound to another origin' : undefined)
          sendJson(res, 404, {
            error: stored.reason === ASSOC_REASONS.UNKNOWN_TASK ? 'unknown taskId' : 'cannot recover task ' + taskId,
            reason: stored.reason,
            ...(hint === undefined ? {} : { hint }),
          })
          return
        }
        const record = stored.record
        const terminal = record.status === 'done' || record.status === 'error' || record.status === 'cancelled'
        // 投递控制（第四轮首次验收修正 A）：回执的"自身已被观察到"是**独立于父任务执行**的持久事实，
        // 重启后不能降级成 unknown（列表视图与单任务查询必须是同一套投影）。
        const receiptView = record.deliver === 'steer'
          ? {
              deliver: 'steer',
              resultScope: record.resultScope === undefined ? 'parent-task' : record.resultScope,
              ...(record.parentTaskId === undefined ? {} : { parentTaskId: record.parentTaskId }),
              ...(record.receiptState === undefined ? {} : { receiptState: record.receiptState }),
              ...(record.observedTurn === undefined ? {} : { observedTurn: record.observedTurn }),
              ...(record.requestSeq === undefined ? {} : { requestSeq: record.requestSeq }),
            }
          : {}
        const receiptStatus = record.deliver !== 'steer' ? undefined
          : (record.receiptState === 'observed' ? 'receipt-observed'
            : (record.receiptState === 'deviated' ? 'receipt-deviated'
              : (record.receiptState === 'unconfirmed' ? 'receipt-unconfirmed' : 'receipt-pending')))
        sendJson(res, 200, {
          taskId: record.taskId,
          originThreadId: record.originThreadId,
          kind: record.kind,
          target: record.target,
          ...(record.profile === undefined ? {} : { profile: record.profile }),
          ...receiptView,
          // 模型路由（第一版验收修正）：执行状态可以是 unknown（不谎报），但**审计事实必须仍可按 origin/task 取回**。
          ...(record.route === undefined || record.route === null ? {} : { route: record.route }),
          ...(record.routePolicy === undefined || record.routePolicy === null ? {} : { routePolicy: record.routePolicy }),
          ...(record.routeStopReason === undefined ? {} : { routeStopReason: record.routeStopReason }),
          routeAudit: readRouteAudit(record.taskId, 20),
          routeAuditWindow: { maxBytes: 1024 * 1024, truncated: routeAuditReader.status().truncated },
          // 非终态记录：**不谎报已完成**，也不重新观察（未实现），明确标未知并禁止重发。
          // 回执例外：自身已观察到的回执**不**降级（父任务执行状态仍可 unknown）。
          status: receiptStatus !== undefined ? receiptStatus : (terminal ? record.status : 'unknown'),
          persistedStatus: record.status,
          recovered: true,
          ...(receiptStatus !== undefined
            ? {
                resend: false,
                note: '补充回执的自身证据已持久化（收据/回合/来源是两维事实）；父任务的执行结果请查父 task。',
              }
            : (terminal
              ? {}
              : {
                  reason: 'execution-state-unconfirmed',
                  note: '这条任务在执行/交付未确认前就失去了运行时上下文（网关重载或新实例）；不重发、不重新观察。原目标见 target。',
                  resend: false,
                })),
          ...(record.delivered === undefined ? {} : { delivered: record.delivered }),
          ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
          ...(record.dshTurn === undefined ? {} : { dshTurn: record.dshTurn }),
          ...(record.result === undefined ? {} : { result: record.result }),
          ...(record.error === undefined ? {} : { error: record.error }),
          ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        return
      }

      // 没有 taskId：只给来源时列出该来源登记过的任务，用来找回丢失的 taskId。
      if (origin.originThreadId !== undefined) {
        const listed = associations === null ? { ok: false, reason: 'association-store-unavailable' } : associations.byOrigin(origin.originThreadId)
        if (listed.ok !== true) {
          sendJson(res, 503, { error: 'task association store is unavailable in this gateway', reason: listed.reason })
          return
        }
        const liveIds = new Set(tasks.filter((t) => t.originThreadId === origin.originThreadId).map((t) => t.taskId))
        sendJson(res, 200, {
          originThreadId: origin.originThreadId,
          count: listed.tasks.length,
          // 与精确查询同一套语义：本实例没有运行上下文的非终态记录只能标 unknown（绝不谎报还在观察）。
          tasks: listed.tasks.map((r) => ({ ...projectStoredTask(r), live: liveIds.has(r.taskId) })),
        })
        return
      }
      const pending = tasks.filter((t) => isNonTerminal(t)).length
      sendJson(res, 200, {
        pending,
        lanes: Array.from(buckets.keys()),
        reviewers: Array.from(reviewerBuckets.keys()),
        sessions: Array.from(new Set(Array.from(sessionTargets.values()).map((r) => r.sessionId))),
        sessionController: sessionControllerNow() !== undefined,
        capabilities: capabilityReport(),
        tasks: tasks.slice(-20).map((t) => ({ taskId: t.taskId, kind: t.kind, status: t.status, cwd: t.cwd, lane: t.lane, target: t.target, deliver: t.deliver })),
      })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/debug',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      // services 是现场探测（不是 apply 时的快照）：sessionController 可能晚于本插件注册，
      // 这份清单能在"接不上会话"时直接告诉我们到底缺哪个服务。
      const probe = (name) => { try { return ctx.get(name) !== undefined } catch (e) { return false } }
      const out = {
        pending: 0, historyCount: history.length, presets: [], providers: [], buckets: [], reviewers: [],
        sessionController: probe('sessionController'),
        services: Object.fromEntries(['sessionController', 'connection', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'agents', 'subagents', 'agentPresets', 'timer', 'llm'].map((n) => [n, probe(n)])),
        sessionTargets: [], models: knownModels, modelProvider, modelListError, workspaces: [],
        capabilities: capabilityReport(),
        observation: observations.status(),
        bridgeVersion,
        routeAuditTail: routeAuditReader.status(),
      }
      out.pending = tasks.filter((t) => isNonTerminal(t)).length
      try { out.providers = subagents.list() } catch (e) { out.providers = ['list failed: ' + errText(e)] }
      if (agentPresets !== undefined) {
        try {
          const list = await agentPresets.list()
          out.presets = list.map((p) => (typeof p === 'string' ? p : (p.id || p.name || '?'))).slice(0, 20)
        } catch (e) { out.presets = ['list failed: ' + errText(e)] }
      }
      if (workspaceRegistry !== undefined) {
        try { out.workspaces = workspaceRegistry.list().map((w) => w.id) } catch (e) { out.workspaces = ['list failed: ' + errText(e)] }
      }
      for (const bucket of buckets.values()) {
        out.buckets.push({ key: bucket.key, cwd: bucket.cwd, lane: bucket.lane, model: bucket.model, childId: bucket.childId })
      }
      for (const bucket of reviewerBuckets.values()) {
        out.reviewers.push({ cwd: bucket.cwd, childId: bucket.childId })
      }
      for (const record of sessionTargets.values()) {
        out.sessionTargets.push({ sessionId: record.sessionId, taskId: record.taskId, deliver: record.deliver, watcher: record.watcher, sawRunning: record.sawRunning })
      }
      sendJson(res, 200, out)
    },
  }))

  ctx.effect(() => webServer.registerUpgrade({
    path: '/api/dsh-bridge/ws',
    handler: (req, socket) => {
      if (!isLoopback(req)) { socket.destroy(); return }
      const upgrade = String(req.headers.upgrade || '').toLowerCase()
      if (upgrade !== 'dsh-bridge') { socket.destroy(); return }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-bridge\r\n\r\n')
      sockets.add(socket)
      let buf = ''
      socket.on('data', (chunk) => {
        buf += new TextDecoder().decode(chunk)
        let idx = buf.indexOf('\n')
        while (idx !== -1) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line !== '') {
            let msg = null
            try { msg = JSON.parse(line) } catch (e) { msg = null }
            if (msg !== null) {
              if (msg.type === 'ping') {
                try { socket.write(JSON.stringify({ type: 'pong', time: Date.now() }) + '\n') } catch (e) {}
              } else if (msg.type === 'instruction' && typeof msg.text === 'string' && msg.text.trim() !== '') {
                const classified = classifyTarget(msg)
                const origin = originOf(msg)
                if (!classified.ok || !origin.ok) {
                  const reason = classified.ok ? ASSOC_REASONS.INVALID_ORIGIN : classified.reason
                  const error = classified.ok ? 'originThreadId must be a non-empty string (<= 200 chars, no control characters)' : classified.message
                  try { socket.write(JSON.stringify({ type: 'error', reason, error, time: Date.now() }) + '\n') } catch (e) { /* drop */ }
                } else {
                  void enqueue(msg.text, msg.history, classified.target, msg.model, 'task', classified.deliver, classified.notes, origin.originThreadId)
                }
              } else if (msg.type === 'review') {
                const origin = originOf(msg)
                if (!origin.ok) {
                  try { socket.write(JSON.stringify({ type: 'error', reason: ASSOC_REASONS.INVALID_ORIGIN, error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)', time: Date.now() }) + '\n') } catch (e) { /* drop */ }
                } else {
                  void submitReview(msg.cwd, msg.diff, msg.focus, msg.history, origin.originThreadId)
                }
              }
            }
          }
          idx = buf.indexOf('\n')
        }
      })
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('error', () => { sockets.delete(socket) })
      socket.write(JSON.stringify({ type: 'hello', lanes: Array.from(buckets.keys()), time: Date.now() }) + '\n')
    },
  }))

  // ---- 原生工具（宿主全局工具层）----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_collab_send',
    description: '向 Codex 协作频道发送一条编码指令。默认新建编码子代理在指定工作目录执行;给出 sessionId 或 sessionQuery 时改为投递进那一条已有会话(会话自带的对话与上下文)。指令用中文。'
      + '【硬规则】验证"这条查询会命中哪条会话"必须用 dryRun=true(只解析、不投递);**绝不投递任何消息去试探命中**——那会作为一条真实用户消息落进对方会话并跑成回合,污染对话。'
      + '【硬规则】返回里 delivered=true 表示消息已被那条会话接受(进了它的队列),即便随后观察到超时或错误也**不要重发**,用 wait=false 记下 taskId 再查状态。'
      + 'sessionQuery 落空时会返回 candidates(按标题相似度 + 最近更新排序),换词重查或改用 sessionId。',
    parameters: {
      instruction: { type: 'string', required: true, description: '要交给编码子代理执行的指令。' },
      cwd: { type: 'string', description: '工作目录(默认 ' + DEFAULT_WORKSPACE + ')。与 sessionId/sessionQuery 互斥。' },
      lane: { type: 'string', description: '并行通道名(默认 main,同目录不同 lane 并行)。' },
      model: { type: 'string', description: '模型别名: default | fast | pro。' },
      sessionId: { type: 'string', description: '已有会话 id:把指令投递进这条会话,而不是新建。' },
      sessionQuery: { type: 'string', description: '按标题/内容搜索已有会话(唯一命中才生效,多条或落空会返回候选)。' },
      deliver: { type: 'string', description: "投递方式: queue(默认,排队,忙时也可靠接收) 或 steer(作为**补充回执**插进父任务当前回合)。" },
      parentTaskId: { type: 'string', description: 'steer 必填: 被补充的父任务 id(dsh_collab_send 返回)。父必须同 origin/同会话且**正在执行**(官方日志证据);绝不按"最近/最老任务"推断。' },
      expectedTurn: { type: 'number', description: 'steer 可选: 期望父任务当前 turn;与实际不符则零投递拒绝。' },
      dryRun: { type: 'boolean', description: '为 true 时只解析目标并回显(含 matchedBy 与候选),不投递任何消息——验证命中用它。' },
      originThreadId: { type: 'string', description: '发起本任务的 Codex 对话 id(来源关联)。必须是显式传入的非空字符串——不要用常驻进程环境或"最近对话"推断。用于之后按 origin+taskId 精确收取结果。' },
      wait: { type: 'boolean', description: '为 true 时等待结果(最长 15 分钟)。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const classified = classifyTarget(args)
      if (!classified.ok) return { ok: false, reason: classified.reason, error: classified.message }
      const origin = originOf(args)
      if (!origin.ok) return { ok: false, reason: ASSOC_REASONS.INVALID_ORIGIN, error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)' }
      // dryRun：只解析目标、回显，不投递。给调用方一条"先验证命中"的正路，免得它发消息试探。
      if (args.dryRun === true) {
        if (classified.target.kind === 'session') {
          const resolved = await resolveSessionTarget(classified.target)
          if (!resolved.ok) {
            return { ok: false, dryRun: true, resolved: false, reason: resolved.reason, error: resolved.message, ...(resolved.candidates.length > 0 ? { candidates: resolved.candidates } : {}) }
          }
          return {
            ok: true, dryRun: true, resolved: true,
            target: { kind: 'session', sessionId: resolved.sessionId, deliver: classified.deliver },
            ...(resolved.snippet === undefined ? {} : { snippet: resolved.snippet }),
            ...(resolved.matchedBy === undefined ? {} : { matchedBy: resolved.matchedBy }),
            ...(resolved.candidates.length > 0 ? { candidates: resolved.candidates } : {}),
            note: '只解析目标，未投递任何消息',
          }
        }
        const cwd = normalizeCwd(classified.target.cwd)
        const lane = normalizeLane(classified.target.lane)
        return { ok: true, dryRun: true, resolved: true, target: { kind: 'worker', cwd, lane }, note: '只解析目标，未派活' }
      }
      // 投递控制（第四轮首次验收修正 F）：原生入口同样要能新建 steer——把 steering 传给同一条派发路径
      // （因此**天然复用**同一套父校验与内部控制凭据语义：这个入口在宿主进程内，不经过 HTTP，
      //  但它绝不放宽校验——缺父/父已结束/错来源一律零投递拒绝）。
      const isSteer = classified.deliver === 'steer' || typeof args.parentTaskId === 'string'
      if (isSteer && args.deliver !== 'steer') return { ok: false, reason: REASONS.PARENT_REQUIRED, error: 'parentTaskId 只在 deliver="steer" 时有效' }
      if (isSteer && (typeof args.parentTaskId !== 'string' || args.parentTaskId.trim() === '')) {
        return { ok: false, reason: REASONS.PARENT_REQUIRED, error: 'steer 必须显式给 parentTaskId（绝不按"最近/最老任务"推断）' }
      }
      // 第二次验收修正 1：原生入口的 steer **同样 fail-closed**——本机没有可信控制 key（或缺/坏）时零派活。
      // 普通非委托 queue 不增加凭据前提（与 HTTP 契约一致）。
      if (isSteer) {
        const auth = nativeControlAuth()
        if (auth.ok !== true) {
          return {
            ok: false,
            reason: auth.reason,
            error: auth.reason === APPROVAL_REASONS.NO_KEY
              ? 'steer 改动既有任务：原生入口需要本机可信控制 key（先运行 --approval-key-init）。缺 key 零派活——本工具**不接受**调用方传入的 raw key。'
              : 'steer 的控制 key 校验失败（格式非法）：零派活。',
            resend: false,
          }
        }
      }
      const steering = isSteer
        ? { parentTaskId: args.parentTaskId.trim(), expectedTurn: Number.isInteger(args.expectedTurn) ? args.expectedTurn : undefined }
        : undefined
      const routePolicy = parseRoutePolicy(args)
      const task = await enqueue(args.instruction, undefined, classified.target, args.model, 'task', classified.deliver, classified.notes, origin.originThreadId, undefined, steering, routePolicy)
      if (task.status === 'error') {
        return { ok: false, taskId: task.taskId, reason: task.reason, error: task.error, ...(task.delivered === true ? { delivered: true } : {}), ...(task.candidates === undefined ? {} : { candidates: task.candidates }) }
      }
      const brief = { taskId: task.taskId, status: task.status, ...taskResponse(task) }
      if (args.wait !== true || timer === undefined) {
        return brief
      }
      // 回执（F/C）：只等**回执自身**的终态（observed/deviated/unconfirmed/pending），绝不等父任务结果。
      if (isSteer) {
        const t0 = Date.now()
        while (task.receiptState === 'accepted' || task.receiptState === 'pending') {
          if (Date.now() - t0 > 30000) break
          await timer.timeout(500)
        }
        return {
          ...brief,
          status: task.status,
          receiptState: task.receiptState,
          resultScope: 'parent-task',
          ...(task.observedTurn === undefined ? {} : { observedTurn: task.observedTurn }),
          resend: false,
          phase: task.receiptState === 'observed' ? 'receipt-observed'
            : (task.receiptState === 'deviated' ? 'receipt-deviated'
              : (task.receiptState === 'unconfirmed' ? 'receipt-unconfirmed' : 'receipt-pending')),
          hint: '这是补充回执（resultScope=parent-task），不代表父任务结果；父任务结果请查父 taskId 的状态；未观察到时不要重发。',
        }
      }
      // 队列语义（F）：queued 也是"在途"，等待时要一直等到真正的终态（或超时）。
      const t0 = Date.now()
      while (task.status === 'accepted' || task.status === 'queued' || task.status === 'running') {
        if (Date.now() - t0 > 900000) return { ...brief, status: task.status, result: task.result, note: 'wait 超时' }
        await timer.timeout(2500)
      }
      return { ...brief, status: task.status, result: task.result, error: task.error, reason: task.reason, ...(task.delivered === true ? { delivered: true, resend: false } : {}) }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_collab_review',
    description: '请独立评审子代理审查某工作目录中的代码变更(diff),评审员会读真实文件并实际运行构建/测试验证可跑通(DeepSeek 侧入口)。',
    parameters: {
      cwd: { type: 'string', required: true, description: '评审目标所在工作目录。' },
      diff: { type: 'string', description: '变更 diff 文本(git diff 输出)。' },
      focus: { type: 'string', description: '审查重点。' },
      originThreadId: { type: 'string', description: '发起本次评审的 Codex 对话 id(来源关联)。必须显式传入；评审同样产生 taskId，因此同样支持按 origin+taskId 收取。' },
      wait: { type: 'boolean', description: '为 true 时等待评审结果(最长 15 分钟)。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const origin = originOf(args)
      if (!origin.ok) return { ok: false, reason: ASSOC_REASONS.INVALID_ORIGIN, error: 'originThreadId must be a non-empty string (<= 200 chars, no control characters)' }
      const task = await submitReview(args.cwd, args.diff, args.focus, undefined, origin.originThreadId)
      if (args.wait !== true || timer === undefined) {
        return { taskId: task.taskId, status: task.status, cwd: task.cwd, ...(task.originThreadId === undefined ? {} : { originThreadId: task.originThreadId }) }
      }
      const t0 = Date.now()
      while (task.status === 'accepted' || task.status === 'running') {
        if (Date.now() - t0 > 900000) return { taskId: task.taskId, status: task.status, result: task.result, note: 'wait 超时' }
        await timer.timeout(2500)
      }
      return { taskId: task.taskId, status: task.status, cwd: task.cwd, result: task.result, error: task.error }
    },
  })))

  ctx.effect(() => () => {
    for (const s of sockets) { try { s.destroy() } catch (e) {} }
    sockets.clear()
    for (const bucket of buckets.values()) {
      bucket.observationAbort?.abort()
      if (bucket.handle !== null) { void bucket.handle.dispose() }
    }
    for (const bucket of reviewerBuckets.values()) {
      bucket.observationAbort?.abort()
      if (bucket.handle !== null) { void bucket.handle.dispose() }
    }
    for (const record of sessionTargets.values()) {
      record.settled = true
      if (record.abort !== undefined) { try { record.abort.abort() } catch (e) { /* ignore */ } }
    }
    sessionTargets.clear()
  })

  console.log('[dsh-bridge] persistent gateway ready (host composition): task(new|session) · sessions · review · tasks · cancel · status · debug · WS | sessionController=' + (sessionControllerNow() !== undefined ? 'yes' : 'late-bound (registers asynchronously)'))
}
