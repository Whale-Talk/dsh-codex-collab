/**
 * dsh-bridge: Codex ↔ DeepSeek Harness 双向协作网关（持久化宿主插件）。
 *
 * 提供：
 *  - POST /api/dsh-bridge/task    编码任务（cwd/lane/model 参数化）
 *  - POST /api/dsh-bridge/review  双向评审（独立评审子代理，必须跑通构建/测试）
 *  - GET  /api/dsh-bridge/tasks   任务列表
 *  - POST /api/dsh-bridge/cancel  取消任务
 *  - GET  /api/dsh-bridge/status  任务状态
 *  - GET  /api/dsh-bridge/debug   调试信息
 *  - WS   /api/dsh-bridge/ws      实时推送（升级协议，供可选客户端使用）
 *
 * 与动态插件版本的关键差异：宿主插件运行在完整 Node 环境，
 * AbortSignal 可用，因此 followup 的 cold-resume 路径不再降级。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

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

  // 清理历史版本可能泄漏的路由条目（重启前的动态插件、旧版本次插件）
  try {
    if (webServer.exact instanceof Map) {
      webServer.exact.delete('/api/dsh-bridge/task')
      webServer.exact.delete('/api/dsh-bridge/status')
      webServer.exact.delete('/api/dsh-bridge/debug')
      webServer.exact.delete('/api/dsh-bridge/review')
      webServer.exact.delete('/api/dsh-bridge/tasks')
      webServer.exact.delete('/api/dsh-bridge/cancel')
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
  const textOfBlocks = (blocks) => {
    if (blocks === undefined || blocks === null) return ''
    let out = ''
    const list = Array.isArray(blocks) ? blocks : [blocks]
    for (const b of list) {
      if (b === undefined || b === null || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
      if (Array.isArray(b.content)) out += textOfBlocks(b.content)
    }
    return out
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

  const enqueue = async (instruction, incomingHistory, rawCwd, rawLane, modelAlias, kind) => {
    if (incomingHistory !== undefined) syncHistory(incomingHistory)
    const cwd = normalizeCwd(rawCwd)
    const lane = normalizeLane(rawLane)
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
    const task = { taskId: uid(), kind, instruction, cwd, lane, bucketKey: bucket.key, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
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
    const task = { taskId: uid(), kind: 'review', instruction, cwd, lane: '@review', bucketKey: bucket.key, status: 'accepted', time: Date.now(), result: undefined, error: undefined }
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

  const assistantTextOf = (event) => {
    if (event === undefined || event === null || event.type !== 'assistant/message') return ''
    const data = event.data
    const msg = data && data.message !== undefined ? data.message : data
    const content = msg && msg.content !== undefined ? msg.content : data && data.content
    return textOfBlocks(content)
  }
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
  if (timer !== undefined) {
    ctx.effect(() => timer.interval(() => {
      void (async () => {
        for (const bucket of buckets.values()) await pollOne(bucket)
        for (const bucket of reviewerBuckets.values()) await pollOne(bucket)
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
      const task = await enqueue(instruction, parsed.history, parsed.cwd, parsed.lane, parsed.model, 'task')
      sendJson(res, 202, { taskId: task.taskId, status: task.status, cwd: task.cwd, lane: task.lane, model: parsed.model || null })
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
      sendJson(res, 200, { tasks: tasks.slice(-50).map((t) => ({ taskId: t.taskId, kind: t.kind, cwd: t.cwd, lane: t.lane, status: t.status, time: t.time, instruction: t.instruction.slice(0, 200), error: t.error, fallback: t.fallback })) })
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
        sendJson(res, 200, { taskId: task.taskId, status: task.status, kind: task.kind, cwd: task.cwd, lane: task.lane, instruction: task.instruction.slice(0, 300), result: task.result, error: task.error, fallback: task.fallback })
        return
      }
      const pending = tasks.filter((t) => t.status === 'accepted' || t.status === 'running').length
      sendJson(res, 200, { pending, lanes: Array.from(buckets.keys()), reviewers: Array.from(reviewerBuckets.keys()), tasks: tasks.slice(-20).map((t) => ({ taskId: t.taskId, kind: t.kind, status: t.status, cwd: t.cwd, lane: t.lane })) })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-bridge/debug',
    handler: async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }
      const out = { pending: 0, historyCount: history.length, presets: [], providers: [], buckets: [], reviewers: [], models: knownModels, modelProvider, modelListError, workspaces: [] }
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
                void enqueue(msg.text, msg.history, msg.cwd, msg.lane, msg.model, 'task')
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
    description: '向 Codex 协作频道发送一条编码指令,由编码子代理在指定工作目录执行(DeepSeek 侧入口)。指令用中文。',
    parameters: {
      instruction: { type: 'string', required: true, description: '要交给编码子代理执行的指令。' },
      cwd: { type: 'string', description: '工作目录(默认 ' + DEFAULT_WORKSPACE + ')。' },
      lane: { type: 'string', description: '并行通道名(默认 main,同目录不同 lane 并行)。' },
      model: { type: 'string', description: '模型别名: default | fast | pro。' },
      wait: { type: 'boolean', description: '为 true 时等待结果(最长 15 分钟)。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const task = await enqueue(args.instruction, undefined, args.cwd, args.lane, args.model, 'task')
      if (args.wait !== true || timer === undefined) {
        return { taskId: task.taskId, status: task.status, cwd: task.cwd, lane: task.lane }
      }
      const t0 = Date.now()
      while (task.status === 'accepted' || task.status === 'running') {
        if (Date.now() - t0 > 900000) return { taskId: task.taskId, status: task.status, result: task.result, note: 'wait 超时' }
        await timer.timeout(2500)
      }
      return { taskId: task.taskId, status: task.status, cwd: task.cwd, lane: task.lane, result: task.result, error: task.error }
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
  })

  console.log('[dsh-bridge] persistent gateway ready (host composition): task · review · tasks · cancel · status · debug · WS')
}
