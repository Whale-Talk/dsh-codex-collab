/**
 * 会话目标的纯决策层。
 *
 * 这里不 import 任何 DSH 模块、不碰 IO，只做判定与文本提取，因此可以在
 * node:test 里直接测。dsh-bridge.mjs 只负责把这里的结论接到真实服务上。
 *
 * 设计要点（对应"找到原对话"与"接通原对话"是两件事）：
 *  - 目标显式：worker（新建，现有行为）与 session（接已有会话）是两个判别分支；
 *  - 无歧义才动手：查询命中 0 条 / 多条都不猜，返回稳定 reason 让调用方决定；
 *  - session 目标绝不静默降级为新建；
 *  - 所有失败都带稳定 reason，调用方不用解析中文文案。
 */

/** 全部稳定失败码。UI/CLI/MCP 都按这些码分支，不解析文案。 */
export const REASONS = {
  INVALID_TARGET: 'invalid-target',
  CONTROLLER_UNAVAILABLE: 'session-controller-unavailable',
  QUERY_EMPTY: 'session-query-empty',
  AMBIGUOUS: 'session-ambiguous',
  NOT_FOUND: 'session-not-found',
  BUSY: 'session-busy',
  WRITER_HELD: 'session-writer-held',
  ARCHIVED: 'session-archived',
  NOT_ACCEPTED: 'session-not-accepted',
  TIMEOUT: 'session-timeout',
  CANCEL_REFUSED: 'session-cancel-refused',
  BAD_REQUEST: 'session-bad-request',
  GATEWAY_INTERNAL: 'session-gateway-internal',
  DISPATCH_FAILED: 'session-dispatch-failed',
}

/** 候选列表回传给调用方时的上限，避免把整个会话库倒出去。 */
export const MAX_CANDIDATES = 10

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/** 把文本块树拍平成纯文本（bridge 的既有语义，抽出来以便复用与单测）。 */
export const textOfBlocks = (blocks) => {
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

/** 从一条会话事件里取助手文本；非助手消息返回空串。 */
export const assistantTextOf = (event) => {
  if (event === undefined || event === null || event.type !== 'assistant/message') return ''
  const data = event.data
  const msg = data && data.message !== undefined ? data.message : data
  const content = msg && msg.content !== undefined ? msg.content : data && data.content
  return textOfBlocks(content)
}

/** 某会话的基线：事件条数 + 助手文本总长。派发前取一次，用来切分"这一轮的输出"。 */
export const baselineOf = (events) => {
  const list = Array.isArray(events) ? events : []
  let textLen = 0
  for (const e of list) textLen += assistantTextOf(e).length
  return { count: list.length, textLen }
}

/**
 * 取出基线之后新增的助手文本。
 * 返回新的基线，调用方直接替换即可（与 bridge 里 lastSeen/seenCount 的用法一致）。
 */
export const extractNewAssistantText = (events, baseline) => {
  const list = Array.isArray(events) ? events : []
  const base = baseline === undefined || baseline === null ? { count: 0, textLen: 0 } : baseline
  let text = ''
  for (const e of list) text += assistantTextOf(e)
  const fresh = text.length > base.textLen ? text.slice(base.textLen) : ''
  return { text: fresh, total: text, baseline: { count: list.length, textLen: text.length } }
}

/**
 * 判定一次派发的目标。
 *
 * 接受两种书写：显式 `target` 对象（HTTP/原生工具），或扁平的 `sessionId`/`sessionQuery`
 * 参数（MCP 工具更好用）。两者同时给出且互相矛盾时按 `invalid-target` 拒绝，绝不猜。
 *
 * @returns {{ok:true, target:object, deliver:'queue'|'steer', notes:string[]}}
 *        | {{ok:false, reason:string, message:string}}
 */
export const classifyTarget = (input) => {
  const raw = input === undefined || input === null ? {} : input
  const notes = []
  const flatSessionId = nonEmpty(raw.sessionId) ? raw.sessionId.trim() : undefined
  const flatQuery = nonEmpty(raw.sessionQuery) ? raw.sessionQuery.trim() : undefined
  const t = raw.target

  // ---- 显式 target 对象 ----
  if (t !== undefined && t !== null) {
    if (typeof t !== 'object' || Array.isArray(t)) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'target must be an object' }
    }
    const kind = t.kind
    if (kind === 'worker') {
      if (nonEmpty(t.sessionId) || nonEmpty(t.query)) {
        return { ok: false, reason: REASONS.INVALID_TARGET, message: 'worker target must not carry session fields' }
      }
      return { ok: true, target: { kind: 'worker', cwd: t.cwd, lane: t.lane }, deliver: 'queue', notes }
    }
    if (kind !== 'session') {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'target.kind must be worker or session' }
    }
    const id = nonEmpty(t.sessionId) ? t.sessionId.trim() : undefined
    const query = nonEmpty(t.query) ? t.query.trim() : undefined
    if (id !== undefined && query !== undefined) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'session target takes sessionId or query, not both' }
    }
    if (id === undefined && query === undefined) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'session target needs sessionId or query' }
    }
    // session 语义自带工作目录与模型：混用会让人以为还能控制它们。
    for (const [field, value] of [['cwd', raw.cwd], ['lane', raw.lane], ['model', raw.model]]) {
      if (nonEmpty(value)) {
        return { ok: false, reason: REASONS.INVALID_TARGET, message: `${field} is not accepted with a session target` }
      }
    }
    if (raw.commit === true) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'commit is not accepted with a session target' }
    }
    const deliver = raw.deliver === undefined ? 'queue' : raw.deliver
    if (deliver !== 'queue' && deliver !== 'steer') {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: "deliver must be 'queue' or 'steer'" }
    }
    if (nonEmpty(raw.history) || (Array.isArray(raw.history) && raw.history.length > 0)) {
      notes.push('history ignored for session targets')
    }
    return { ok: true, target: { kind: 'session', sessionId: id, query }, deliver, notes }
  }

  // ---- 扁平写法（MCP 工具的 sessionId/sessionQuery）----
  if (flatSessionId !== undefined || flatQuery !== undefined) {
    if (flatSessionId !== undefined && flatQuery !== undefined) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'pass sessionId or sessionQuery, not both' }
    }
    if (nonEmpty(raw.cwd) || nonEmpty(raw.lane)) {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: 'cwd/lane are not accepted with a session target' }
    }
    const deliver = raw.deliver === undefined ? 'queue' : raw.deliver
    if (deliver !== 'queue' && deliver !== 'steer') {
      return { ok: false, reason: REASONS.INVALID_TARGET, message: "deliver must be 'queue' or 'steer'" }
    }
    if (Array.isArray(raw.history) && raw.history.length > 0) notes.push('history ignored for session targets')
    return { ok: true, target: { kind: 'session', sessionId: flatSessionId, query: flatQuery }, deliver, notes }
  }

  // ---- 默认：worker（与 0.1.1 完全一致）----
  return { ok: true, target: { kind: 'worker', cwd: raw.cwd, lane: raw.lane }, deliver: 'queue', notes }
}

/**
 * 从搜索结果里挑出唯一目标。0 条与多条都不猜：多条时把候选回传，由调用方指定 id。
 * 显式 sessionId 优先，完全不查注册表。
 */
export const selectSession = (hits, target) => {
  const t = target === undefined || target === null ? {} : target
  if (nonEmpty(t.sessionId)) {
    return { ok: true, sessionId: t.sessionId.trim(), snippet: undefined, candidates: [] }
  }
  const list = Array.isArray(hits) ? hits.filter((h) => h !== null && typeof h === 'object' && nonEmpty(h.sessionId)) : []
  const candidates = list.slice(0, MAX_CANDIDATES).map((h) => ({ sessionId: h.sessionId, snippet: typeof h.snippet === 'string' ? h.snippet.slice(0, 200) : '' }))
  if (list.length === 0) {
    return { ok: false, reason: REASONS.QUERY_EMPTY, message: `no session matched ${JSON.stringify(t.query)}`, candidates: [] }
  }
  if (list.length > 1) {
    return { ok: false, reason: REASONS.AMBIGUOUS, message: `${list.length} sessions matched ${JSON.stringify(t.query)}; pass sessionId`, candidates }
  }
  return { ok: true, sessionId: list[0].sessionId, snippet: candidates[0].snippet, candidates }
}

/** 把 sessionController 抛出的 RemoteError 映射成稳定 reason。 */
export const mapControllerError = (error) => {
  const code = (error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '')
    || (error !== null && typeof error === 'object' && error.cause !== null && typeof error.cause === 'object' && typeof error.cause.code === 'string' ? error.cause.code : '')
  switch (code) {
    case 'session/not-found': return REASONS.NOT_FOUND
    case 'session/agent-busy': return REASONS.BUSY
    case 'session/writer-held': return REASONS.WRITER_HELD
    case 'session/invalid-time-zone': return REASONS.INVALID_TARGET
    case 'gateway/bad-request': return REASONS.BAD_REQUEST
    case 'gateway/internal': return REASONS.GATEWAY_INTERNAL
    default: return REASONS.DISPATCH_FAILED
  }
}

/**
 * 从 SessionSummary 里取标题。
 *
 * 标题不在 summary 顶层：它来自投影缓存（`projections.values.title`），而且不同 DSH
 * 版本可能给字符串或 `{ val }` 包装，两种都认。`list` 在**不激活 Agent、也不打开
 * search 索引**的前提下读持久化 header 与投影缓存，因此在 search 被部署禁用
 * （session-query 索引 openAt: "never"）时，它是唯一还能按标题找会话的路径。
 */
export const sessionTitleOf = (summary) => {
  if (summary === null || typeof summary !== 'object') return ''
  const projections = summary.projections
  if (projections === null || typeof projections !== 'object') return ''
  const values = projections.values
  if (values === null || typeof values !== 'object') return ''
  const title = values.title
  if (typeof title === 'string') return title
  if (title !== null && typeof title === 'object' && typeof title.val === 'string') return title.val
  return ''
}

/** search 在本部署被禁用时的报错特征（session-query 索引 openAt: "never"）。 */
export const looksLikeDisabledSearch = (error) => {
  const text = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error === undefined || error === null ? '' : error)
  return /search is disabled/i.test(text)
}

/** 任务在 HTTP 行上的回显：调用方一眼能看出这次是"新建"还是"接进哪个会话"。 */
export const taskResponse = (task) => {
  const out = { taskId: task.taskId, status: task.status, kind: task.kind }
  const target = task.target !== undefined && task.target !== null
    ? task.target
    // 兼容 0.1.1 之前落下的记录（如 review 任务）：没有 target 字段时按 worker 回显。
    : { kind: 'worker', cwd: task.cwd, lane: task.lane }
  if (target.kind === 'session') {
    out.target = { kind: 'session', sessionId: target.sessionId, deliver: task.deliver }
    if (target.snippet !== undefined) out.target.snippet = target.snippet
  } else {
    out.target = { kind: 'worker', cwd: target.cwd, lane: target.lane }
  }
  if (Array.isArray(task.notes) && task.notes.length > 0) out.notes = task.notes
  return out
}
