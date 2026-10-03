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
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  REASONS,
  textOfBlocks,
  assistantTextOf,
  baselineOf,
  extractNewAssistantText,
  classifyTarget,
  selectSession,
  mapControllerError,
  sessionTitleOf,
  looksLikeDisabledSearch,
  taskResponse,
} from './session-target.mjs'

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
    const started = await subagents.startContinuable({
      provider,
      label: bucket.lane === '@review' ? 'codex-collab-reviewer' : 'codex-collab-worker-' + bucket.lane,
      request,
      signal: signalOf(),
    })
    bucket.childId = started.childId
    console.log('[dsh-bridge] worker started for', bucket.key, ':', bucket.childId, 'model:', bucket.model)
    return bucket.childId
  }

  const onChildEnd = (bucket, info) => {
    if (bucket.childId === null || info.id !== bucket.childId) return
    const text = textOfBlocks(info.lastAssistantMessage)
    const pending = tasks.filter((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
    const task = pending.length > 0 ? pending[0] : null
    if (task !== null) {
      task.status = 'done'
      task.result = text.length > 0 ? text : '(无输出)'
      task.stopReason = info.stopReason
      remember('user', task.instruction)
      remember('assistant', task.result)
      pushTask(task.taskId, 'result', { text: task.result, stopReason: info.stopReason, childId: bucket.childId, cwd: bucket.cwd, kind: task.kind })
    } else {
      broadcast({ type: 'result', taskId: null, childId: bucket.childId, time: Date.now(), text, stopReason: info.stopReason, cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
    }
    bucket.activeSince = 0
  }

  const deliver = async (bucket, instruction, brief, followupPrefix) => {
    const parent = await ensureOwner(bucket)
    if (bucket.childId === null) {
      if (bucket.childPromise === null) {
        bucket.childPromise = startChildWith(bucket, instruction, brief).catch((e) => { bucket.childPromise = null; throw e })
        await bucket.childPromise
      } else {
        await bucket.childPromise
        await subagents.followup(parent, bucket.childId, [{ type: 'text', text: followupPrefix + instruction }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: signalOf(),
        })
      }
    } else {
      try {
        await subagents.followup(parent, bucket.childId, [{ type: 'text', text: followupPrefix + instruction }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: signalOf(),
        })
      } catch (followupError) {
        // 兜底：one-shot + 历史摘要（正常情况下宿主插件的真 AbortSignal 已打通 cold-resume）
        const digest = historyDigest()
        const text = (digest !== '' ? digest + '\n\n' : '') + brief + instruction
        const request = { prompt: [{ type: 'text', text }], parent, signal: signalOf() }
        if (bucket.model !== null) request.agentOptions = { model: bucket.model }
        const run = await subagents.start('spawn', Object.assign({ label: 'codex-collab-' + bucket.lane + '-' + uid() }, request))
        const result = await run.result
        const out = textOfBlocks(result.output)
        bucket.childId = null
        bucket.childPromise = null
        bucket.lastSeen = 0
        bucket.seenCount = 0
        void run.dispose()
        return { fallback: true, output: out.length > 0 ? out : '(无输出)', stopReason: result.stopReason, fallbackNote: 'one-shot (cold-resume unavailable: ' + errText(followupError).slice(0, 200) + ')' }
      }
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
  /** 单个会话任务的总预算上限。 */
  const SESSION_TOTAL_TIMEOUT_MS = envMs('DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS', 3600000)
  // sessionTargets 以 sessionId 为键：同一会话同时只允许一个在途 bridge 任务。
  // DSH 自己会排队，但我们无法可靠地把两次并发派的回报各自归属，所以宁可明确拒绝。
  const sessionTargets = new Map()

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
    if (!picked.ok) return picked
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

  const sessionPendingTask = (sessionId) => tasks.find((t) => (t.status === 'accepted' || t.status === 'running') && t.target !== undefined && t.target.kind === 'session' && t.target.sessionId === sessionId)

  const settleSessionTask = (record, status, fields) => {
    if (record.settled) return
    record.settled = true
    if (record.abort !== undefined) { try { record.abort.abort() } catch (e) { /* ignore */ } }
    sessionTargets.delete(record.sessionId)
    const task = tasks.find((t) => t.taskId === record.taskId)
    if (task === undefined) return
    task.status = status
    if (fields.result !== undefined) task.result = fields.result
    if (fields.error !== undefined) task.error = fields.error
    if (fields.reason !== undefined) task.reason = fields.reason
    if (fields.stopReason !== undefined) task.stopReason = fields.stopReason
    pushTask(task.taskId, status === 'done' ? 'result' : 'error', {
      ...(task.result === undefined ? {} : { text: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      target: { kind: 'session', sessionId: record.sessionId },
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    })
  }

  /** 收尾时以「持久日志 + 派发前基线」为准，避免只信流式片段。 */
  const finishSessionTask = (record, stopReason) => {
    if (record.settled) return
    void (async () => {
      let text = record.total
      if (sessionQuery !== undefined) {
        try {
          const snap = await sessionQuery.readSession(record.sessionId)
          const events = snap !== undefined && snap !== null && Array.isArray(snap.events) ? snap.events : []
          const extracted = extractNewAssistantText(events, record.baseline)
          record.baseline = extracted.baseline
          if (extracted.text.trim() !== '') text = record.total + extracted.text
        } catch (e) {
          console.error('[dsh-bridge] session result read failed:', errText(e).slice(0, 200))
        }
      }
      settleSessionTask(record, 'done', { result: text.trim() !== '' ? text.trim() : '(无输出)', stopReason })
    })()
  }

  const watchSessionTask = (record) => {
    // 主路径：follow 增量流（不激活 Agent，也不重读整份日志——目标会话可能有几十 MB）。
    const controller = new AbortController()
    record.abort = controller
    record.watcher = 'follow'
    void (async () => {
      try {
        const controllerRef = sessionControllerNow()
        if (controllerRef === undefined) throw new Error('sessionController is not mounted')
        const stream = controllerRef.follow({ address: { kind: 'session', sessionId: record.sessionId } }, controller.signal)
        for await (const frame of stream) {
          if (record.settled) break
          if (frame === null || typeof frame !== 'object') continue
          if (frame.type !== 'event') continue // snapshot 是派发前的历史，不作为本轮输出
          const text = assistantTextOf(frame.event)
          if (text === '') continue
          record.total += text
          record.activeSince = Date.now()
          const task = tasks.find((t) => t.taskId === record.taskId)
          if (task !== undefined && task.status === 'accepted') task.status = 'running'
          pushTask(record.taskId, 'progress', { text, target: { kind: 'session', sessionId: record.sessionId } })
        }
      } catch (e) {
        if (record.settled) return
        // 降级：交给 2.5s 轮询（与子代理路径同一套解析），并在任务上标出来以便观测。
        record.watcher = 'poll'
        console.error('[dsh-bridge] follow unavailable, falling back to polling:', errText(e).slice(0, 200))
      }
    })()
  }

  /** 派发一条指令进已有会话。任何失败都不创建会话，只落一个 error 任务。 */
  const dispatchToSession = async (instruction, target, deliver, notes, incomingHistory) => {
    const task = {
      taskId: uid(), kind: 'task', instruction,
      target: { kind: 'session', sessionId: target.sessionId, query: target.query, snippet: target.snippet },
      deliver, notes, status: 'accepted', time: Date.now(), result: undefined, error: undefined,
      cwd: undefined, lane: undefined, bucketKey: undefined,
    }
    tasks.push(task)
    if (tasks.length > 200) tasks.splice(0, tasks.length - 200)

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

    const inFlight = sessionPendingTask(resolved.sessionId)
    if (inFlight !== undefined && inFlight.taskId !== task.taskId) {
      task.status = 'error'
      task.error = 'another bridge task is already pending on this session'
      task.reason = REASONS.BUSY
      pushTask(task.taskId, 'error', { error: task.error, reason: task.reason, target: { kind: 'session', sessionId: resolved.sessionId } })
      return { task, failed: { reason: REASONS.BUSY, message: task.error, candidates: [] } }
    }

    // 派发前取基线：结果只回报这一轮新产生的助手文本。
    let baseline = { count: 0, textLen: 0 }
    if (sessionQuery !== undefined) {
      try {
        const snap = await sessionQuery.readSession(resolved.sessionId)
        const events = snap !== undefined && snap !== null && Array.isArray(snap.events) ? snap.events : []
        baseline = baselineOf(events)
      } catch (e) {
        console.error('[dsh-bridge] session baseline read failed:', errText(e).slice(0, 200))
      }
    }
    const record = {
      sessionId: resolved.sessionId, taskId: task.taskId, deliver, baseline,
      total: '', sawRunning: false, activeSince: Date.now(), startedAt: Date.now(),
      settled: false, abort: undefined, watcher: 'pending',
    }
    sessionTargets.set(resolved.sessionId, record)

    try {
      const controllerRef = sessionControllerNow()
      if (controllerRef === undefined) {
        sessionTargets.delete(resolved.sessionId)
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
        mode: deliver,
        content: [{ type: 'text', text: instruction }],
      }, signalOf())
    } catch (e) {
      const reason = mapControllerError(e)
      sessionTargets.delete(resolved.sessionId)
      record.settled = true
      task.status = 'error'
      task.error = errText(e)
      task.reason = reason
      pushTask(task.taskId, 'error', { error: task.error, reason: reason, target: { kind: 'session', sessionId: resolved.sessionId } })
      return { task, failed: { reason, message: task.error, candidates: [] } }
    }

    watchSessionTask(record)
    pushTask(task.taskId, 'task-accepted', { target: { kind: 'session', sessionId: resolved.sessionId }, deliver, cwd: resolved.snippet })
    return { task, failed: null }
  }

  const enqueue = async (instruction, incomingHistory, target, modelAlias, kind, deliver, notes) => {
    if (incomingHistory !== undefined) syncHistory(incomingHistory)
    if (target !== undefined && target.kind === 'session') {
      // session 目标：不注册工作区、不建 owner、不建子代理，失败也不降级为新建。
      const dispatched = await dispatchToSession(
        instruction, target,
        deliver === undefined ? 'queue' : deliver,
        Array.isArray(notes) ? notes : [],
        incomingHistory,
      )
      return dispatched.task
    }
    const cwd = normalizeCwd(target === undefined ? undefined : target.cwd)
    const lane = normalizeLane(target === undefined ? undefined : target.lane)
    registerWorkspace(cwd)
    const bucket = bucketOf(cwd, lane)
    const requestedModel = await resolveModel(modelAlias)
    if (requestedModel !== null && requestedModel !== bucket.model) {
      bucket.model = requestedModel
      bucket.childId = null
      bucket.childPromise = null
      bucket.lastSeen = 0
      bucket.seenCount = 0
    }
    const task = { taskId: uid(), kind, instruction, cwd, lane, bucketKey: bucket.key, target: { kind: 'worker', cwd, lane }, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
    tasks.push(task)
    if (tasks.length > 200) tasks.splice(0, tasks.length - 200)
    try {
      const delivered = await deliver(bucket, instruction, ROLE_BRIEF(cwd), '[Codex 指令] ')
      if (delivered.fallback) {
        task.status = 'done'
        task.result = delivered.output
        task.stopReason = delivered.stopReason
        task.fallback = delivered.fallbackNote
        remember('user', instruction)
        remember('assistant', task.result)
        pushTask(task.taskId, 'result', { text: task.result, stopReason: delivered.stopReason, childId: null, cwd, kind })
      } else {
        bucket.activeSince = Date.now()
        pushTask(task.taskId, 'task-accepted', { childId: bucket.childId, cwd, kind })
      }
    } catch (e) {
      task.status = 'error'
      task.error = errText(e)
      pushTask(task.taskId, 'error', { error: task.error, cwd, kind })
    }
    return task
  }

  const submitReview = async (rawCwd, diff, focus, incomingHistory) => {
    if (incomingHistory !== undefined) syncHistory(incomingHistory)
    const cwd = normalizeCwd(rawCwd)
    const bucket = reviewerBucketOf(cwd)
    const instruction = ['【变更 diff】\n' + (typeof diff === 'string' && diff.trim() !== '' ? diff.slice(0, 60000) : '(未提供 diff)'), '【审查重点】\n' + (typeof focus === 'string' && focus.trim() !== '' ? focus.slice(0, 4000) : '(未指定,请按一般标准审查)')].join('\n\n')
    const task = { taskId: uid(), kind: 'review', instruction, cwd, lane: '@review', bucketKey: bucket.key, target: { kind: 'worker', cwd, lane: '@review' }, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
    tasks.push(task)
    if (tasks.length > 200) tasks.splice(0, tasks.length - 200)
    try {
      const delivered = await deliver(bucket, instruction, REVIEWER_BRIEF(cwd), '[评审请求] ')
      if (delivered.fallback) {
        task.status = 'done'
        task.result = delivered.output
        task.stopReason = delivered.stopReason
        task.fallback = delivered.fallbackNote
        remember('user', '[评审请求] ' + (typeof focus === 'string' && focus !== '' ? focus : 'diff 审查'))
        remember('assistant', task.result)
        pushTask(task.taskId, 'result', { text: task.result, stopReason: delivered.stopReason, childId: null, cwd, kind: 'review' })
      } else {
        bucket.activeSince = Date.now()
        pushTask(task.taskId, 'task-accepted', { childId: bucket.childId, cwd, kind: 'review' })
      }
    } catch (e) {
      task.status = 'error'
      task.error = errText(e)
      pushTask(task.taskId, 'error', { error: task.error, cwd, kind: 'review' })
    }
    return task
  }

  // assistantTextOf / textOfBlocks 由 session-target.mjs 提供（同一套语义，可单测）。
  const pollOne = async (bucket) => {
    if (bucket.childId === null || sessionQuery === undefined) return
    const hasPending = tasks.some((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
    let snap
    try { snap = await sessionQuery.readSession(bucket.childId) } catch (e) { return }
    const events = snap && Array.isArray(snap.events) ? snap.events : []
    let total = ''
    for (const e of events) total += assistantTextOf(e) + '\n'
    const fresh = total.slice(bucket.lastSeen)
    bucket.lastSeen = total.length
    const newEvents = events.length > bucket.seenCount
    bucket.seenCount = events.length
    if (!hasPending) return
    if (newEvents) bucket.activeSince = Date.now()
    if (fresh.trim() !== '') {
      const active = tasks.find((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
      if (active !== undefined) active.status = 'running'
      pushTask(active !== undefined ? active.taskId : bucket.childId, 'progress', { text: fresh.trim(), cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
    }
    if (bucket.activeSince > 0 && Date.now() - bucket.activeSince > 600000) {
      const active = tasks.find((t) => (t.status === 'accepted' || t.status === 'running') && t.bucketKey === bucket.key)
      if (active !== undefined && total.length > 0) {
        active.status = 'done'
        active.result = total.slice(Math.max(0, total.length - 4000)).trim() || '(无输出)'
        pushTask(active.taskId, 'result', { text: active.result, stopReason: 'quiet-timeout', childId: bucket.childId, cwd: bucket.cwd, kind: bucket.lane === '@review' ? 'review' : 'task' })
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
      if (task.status === 'cancelled') { record.settled = true; if (record.abort !== undefined) { try { record.abort.abort() } catch (e) { /* ignore */ } } sessionTargets.delete(record.sessionId); continue }
      const now = Date.now()
      if (record.watcher === 'poll' && sessionQuery !== undefined) {
        try {
          const snap = await sessionQuery.readSession(record.sessionId)
          const events = snap !== undefined && snap !== null && Array.isArray(snap.events) ? snap.events : []
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
      if (!record.sawRunning && now - record.startedAt > SESSION_DISPATCH_TIMEOUT_MS) {
        settleSessionTask(record, 'error', { error: 'the session never started a turn after the prompt was accepted (it may still be queued)', reason: REASONS.NOT_ACCEPTED })
        continue
      }
      if (record.sawRunning && record.activeSince > 0 && now - record.activeSince > SESSION_QUIET_TIMEOUT_MS) {
        finishSessionTask(record, 'quiet-timeout')
        continue
      }
      if (now - record.startedAt > SESSION_TOTAL_TIMEOUT_MS) {
        settleSessionTask(record, 'error', { error: 'session task exceeded its total budget', reason: REASONS.TIMEOUT })
      }
    }
  }

  // 完成信号：会话从 running 回到 idle 即这一轮结束（follow 只负责流式进度）。
  // 订阅的是 ctx 上的事件，与服务何时注册无关，所以不设门禁。
  {
    ctx.effect(() => {
      const off = ctx.on('api-session/status', (sessionId, running) => {
        const record = sessionTargets.get(sessionId)
        if (record === undefined || record.settled) return
        const task = tasks.find((t) => t.taskId === record.taskId)
        if (running === true) {
          record.sawRunning = true
          record.activeSince = Date.now()
          if (task !== undefined && task.status === 'accepted') task.status = 'running'
          return
        }
        if (running === false && record.sawRunning) finishSessionTask(record, 'stop')
      })
      return () => { if (typeof off === 'function') off() }
    })
  }

  if (timer !== undefined) {
    ctx.effect(() => timer.interval(() => {
      void (async () => {
        for (const bucket of buckets.values()) await pollOne(bucket)
        for (const bucket of reviewerBuckets.values()) await pollOne(bucket)
        await sweepSessionTargets()
      })()
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
      if (instruction.trim() === '') { sendJson(res, 400, { error: 'missing instruction' }); return }
      const classified = classifyTarget(parsed)
      if (!classified.ok) { sendJson(res, 400, { error: classified.message, reason: classified.reason }); return }
      const task = await enqueue(instruction, parsed.history, classified.target, parsed.model, 'task', classified.deliver, classified.notes)
      if (task.status === 'error') {
        sendJson(res, 400, {
          error: task.error,
          reason: task.reason,
          ...(Array.isArray(task.candidates) && task.candidates.length > 0 ? { candidates: task.candidates } : {}),
        })
        return
      }
      sendJson(res, 202, {
        ...taskResponse(task),
        model: classified.target.kind === 'worker' ? (parsed.model || null) : null,
      })
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
        sendJson(res, 200, { items, hasMore: hits.length > items.length, total: hits.length, matchedBy: found.matchedBy })
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
      const task = await submitReview(parsed.cwd, parsed.diff, parsed.focus, parsed.history)
      sendJson(res, 202, { taskId: task.taskId, status: task.status, cwd: task.cwd, kind: 'review' })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/tasks',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      sendJson(res, 200, { tasks: tasks.slice(-50).map((t) => ({ taskId: t.taskId, kind: t.kind, cwd: t.cwd, lane: t.lane, target: t.target, deliver: t.deliver, status: t.status, time: t.time, instruction: t.instruction.slice(0, 200), error: t.error, reason: t.reason, fallback: t.fallback })) })
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
      const task = tasks.find((t) => t.taskId === taskId)
      if (task === undefined) { sendJson(res, 404, { error: 'unknown taskId' }); return }
      if (task.status !== 'accepted' && task.status !== 'running') { sendJson(res, 200, { taskId, cancelled: false, status: task.status }); return }

      // session 目标动的是用户自己的对话：取消会打断他正在跑的回合，因此必须显式 force。
      if (task.target !== undefined && task.target.kind === 'session') {
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
        const record = sessionTargets.get(task.target.sessionId)
        if (record !== undefined) settleSessionTask(record, 'cancelled', {})
        pushTask(taskId, 'cancelled', { target: { kind: 'session', sessionId: task.target.sessionId } })
        sendJson(res, 200, { taskId, cancelled: true, interrupted: cancelled, target: task.target })
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
      pushTask(taskId, 'cancelled', { cwd: task.cwd })
      sendJson(res, 200, { taskId, cancelled: true, interrupted })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const qs = qsOf(req)
      const taskId = qs.taskId
      if (taskId !== undefined && taskId !== '') {
        const task = tasks.find((t) => t.taskId === taskId)
        if (task === undefined) { sendJson(res, 404, { error: 'unknown taskId' }); return }
        const record = task.target !== undefined && task.target.kind === 'session' ? sessionTargets.get(task.target.sessionId) : undefined
        sendJson(res, 200, {
          taskId: task.taskId, status: task.status, kind: task.kind, cwd: task.cwd, lane: task.lane,
          target: task.target, deliver: task.deliver, instruction: task.instruction.slice(0, 300),
          result: task.result, error: task.error, reason: task.reason, fallback: task.fallback,
          ...(task.matchedBy === undefined ? {} : { matchedBy: task.matchedBy }),
          ...(Array.isArray(task.candidates) && task.candidates.length > 0 ? { candidates: task.candidates } : {}),
          ...(record === undefined ? {} : { watcher: record.watcher, sawRunning: record.sawRunning }),
        })
        return
      }
      const pending = tasks.filter((t) => t.status === 'accepted' || t.status === 'running').length
      sendJson(res, 200, {
        pending,
        lanes: Array.from(buckets.keys()),
        reviewers: Array.from(reviewerBuckets.keys()),
        sessions: Array.from(sessionTargets.keys()),
        sessionController: sessionControllerNow() !== undefined,
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
      }
      out.pending = tasks.filter((t) => t.status === 'accepted' || t.status === 'running').length
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
                if (!classified.ok) {
                  try { socket.write(JSON.stringify({ type: 'error', reason: classified.reason, error: classified.message, time: Date.now() }) + '\n') } catch (e) { /* drop */ }
                } else {
                  void enqueue(msg.text, msg.history, classified.target, msg.model, 'task', classified.deliver, classified.notes)
                }
              } else if (msg.type === 'review') {
                void submitReview(msg.cwd, msg.diff, msg.focus, msg.history)
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
    description: '向 Codex 协作频道发送一条编码指令。默认新建编码子代理在指定工作目录执行;给出 sessionId 或 sessionQuery 时改为投递进那一条已有会话(会话自带的对话与上下文)。指令用中文。',
    parameters: {
      instruction: { type: 'string', required: true, description: '要交给编码子代理执行的指令。' },
      cwd: { type: 'string', description: '工作目录(默认 ' + DEFAULT_WORKSPACE + ')。与 sessionId/sessionQuery 互斥。' },
      lane: { type: 'string', description: '并行通道名(默认 main,同目录不同 lane 并行)。' },
      model: { type: 'string', description: '模型别名: default | fast | pro。' },
      sessionId: { type: 'string', description: '已有会话 id:把指令投递进这条会话,而不是新建。' },
      sessionQuery: { type: 'string', description: '按标题/内容搜索已有会话(唯一命中才生效,多条会返回候选)。' },
      deliver: { type: 'string', description: "投递方式: queue(默认,排队) 或 steer(插入当前回合)。" },
      wait: { type: 'boolean', description: '为 true 时等待结果(最长 15 分钟)。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const classified = classifyTarget(args)
      if (!classified.ok) return { ok: false, reason: classified.reason, error: classified.message }
      const task = await enqueue(args.instruction, undefined, classified.target, args.model, 'task', classified.deliver, classified.notes)
      if (task.status === 'error') {
        return { ok: false, taskId: task.taskId, reason: task.reason, error: task.error, ...(task.candidates === undefined ? {} : { candidates: task.candidates }) }
      }
      const brief = { taskId: task.taskId, status: task.status, ...taskResponse(task) }
      if (args.wait !== true || timer === undefined) {
        return brief
      }
      const t0 = Date.now()
      while (task.status === 'accepted' || task.status === 'running') {
        if (Date.now() - t0 > 900000) return { ...brief, status: task.status, result: task.result, note: 'wait 超时' }
        await timer.timeout(2500)
      }
      return { ...brief, status: task.status, result: task.result, error: task.error, reason: task.reason }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_collab_review',
    description: '请独立评审子代理审查某工作目录中的代码变更(diff),评审员会读真实文件并实际运行构建/测试验证可跑通(DeepSeek 侧入口)。',
    parameters: {
      cwd: { type: 'string', required: true, description: '评审目标所在工作目录。' },
      diff: { type: 'string', description: '变更 diff 文本(git diff 输出)。' },
      focus: { type: 'string', description: '审查重点。' },
      wait: { type: 'boolean', description: '为 true 时等待评审结果(最长 15 分钟)。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const task = await submitReview(args.cwd, args.diff, args.focus, undefined)
      if (args.wait !== true || timer === undefined) {
        return { taskId: task.taskId, status: task.status, cwd: task.cwd }
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
      if (bucket.handle !== null) { void bucket.handle.dispose() }
    }
    for (const bucket of reviewerBuckets.values()) {
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
