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
  /** 带来源的会话任务不能精确关联到单个请求回合：在执行前拒绝 steer。 */
  ORIGIN_STEER_UNSUPPORTED: 'origin-steer-unsupported',
  // ---- 投递控制（queue / steer）的稳定失败码 ----
  /** steer 必须显式给出父任务（不允许按"最近/最老任务"推断）。 */
  PARENT_REQUIRED: 'steer-parent-required',
  /** 给的父任务不存在、不属于同一来源/会话/档案，或不是真实在执行的队列任务。 */
  PARENT_INVALID: 'steer-parent-invalid',
  /** 父任务已终态（不可能再插入）。 */
  PARENT_TERMINAL: 'steer-parent-terminal',
  /** 父任务还在排队（还没真正开始执行）——插入没有意义，执行前拒绝。 */
  PARENT_QUEUED: 'steer-parent-queued',
  /** 给了 expectedTurn 但与父任务当前真实 turn 不一致。 */
  PARENT_TURN_MISMATCH: 'steer-turn-mismatch',
  /** 无来源的 steer 会改动别人的在途任务：零投递拒绝。 */
  ORIGIN_REQUIRED_FOR_STEER: 'steer-origin-required',
  /** 旧无来源（不可精确关联）任务与新的来源绑定任务混在同一会话：拒绝这种不安全组合。 */
  LEGACY_MIX_UNSAFE: 'legacy-mix-unsafe',
  /** 回执已接收但没能观察到自己的 rpcId 落进父回合（不重发、不猜）。 */
  RECEIPT_UNCONFIRMED: 'steer-receipt-unconfirmed',
  /** 回执落进了**另一个**回合（官方异步 admission / wakingAfterAbort 改道）：如实报告偏离，绝不假成功。 */
  RECEIPT_TURN_DEVIATED: 'steer-turn-deviated',
  /** steer 预检时父任务的回合已经结束（官方日志证据）：执行前拒绝。 */
  PARENT_TURN_CLOSED: 'steer-parent-turn-closed',
  /** 模型路由：精确指定的 pair/model 不在已配置目录内，或同名跨 provider 歧义 → 派活前拒绝（不静默选错）。 */
  MODEL_ROUTE_INVALID: 'model-route-invalid',
  /** 模型路由已按"本任务"终态收口（候选耗尽/禁 fallback 终止等）：稳定 reason，客户端不重发、不冒充成功。 */
  MODEL_ROUTE_EXHAUSTED: 'model-route-exhausted',
  /** 子代理回合以失败 stopReason 结束（error/aborted/refusal/max-tokens…）：绝不 done。 */
  SUBAGENT_TURN_FAILED: 'subagent-turn-failed',
  /** 关联到了请求回合，但该回合以非 completed 结束（aborted/blocked/error/…）。 */
  TURN_FAILED: 'session-turn-failed',
  /** 没有任何证据能确认这个请求回合的结局（不猜、不重发）。 */
  UNCONFIRMED: 'execution-state-unconfirmed',
}

/** `turn/end` 的 reason.kind 枚举（来自 driver/typert）：**只有 completed 算成功**。 */
export const TURN_END_KINDS = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']
export const SUCCESS_TURN_END = 'completed'

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
 * 收尾时选哪一份文本作为汇报。
 *
 * 以"派发后重读持久日志"得到的整轮文本为准——它是流式累计的超集；只有重读失败
 * 或结果为空时，才退回 follow 累计的那份。**绝不能把两者相加**：那会让汇报重复
 * 两遍（v0.1.4 的真实缺陷，在真实会话上实测出现）。
 */
export const pickSessionResult = (streamed, extracted) => {
  const fromLog = typeof extracted === 'string' ? extracted.trim() : ''
  if (fromLog !== '') return fromLog
  const fromStream = typeof streamed === 'string' ? streamed.trim() : ''
  return fromStream !== '' ? fromStream : '(无输出)'
}

/**
 * 请求 → DSH turn 的关联器（纯函数群）。
 *
 * 依据（本机 controller 0.2.0-rc.2 的实测字段）：
 *  - `prompt.requestId` 会被写进 `user/message` 的 `event.data.source.rpcId`——这是"这条用户消息属于
 *    哪次请求"的**唯一可靠凭据**（我们用 taskId 当 requestId）；
 *  - **`user/message.data.turn` 不存在**：turn 号只能靠按 seq 有序跟踪"已 turn/start 但还没 turn/end"
 *    的回合得到，遇到 rpcId 匹配的 user/message 时把它归到**当时仍未闭合**的那个 turn；
 *  - `assistant/message.data = {turn, step, message:{content:[...]}}`：只收自己那个 turn 的助手文本；
 *  - `turn/end.data = {turn, reason:{kind,…}}`：这是本次请求结束的依据；**只有 completed 算成功**；
 *  - `api-session/status` 只表示 agent 当前是否 running（连续跑 queued turn 时可能没有新的 running=true），
 *    因此它**绝不能**当作某个请求完成的证明。
 *
 * 同一套规则被 live follow 帧、follow 开场 snapshot.records、以及轮询读日志共用；`seq` 去重保证
 * 同一条事件被多条路径投递时也只算一次、不串文本。
 */
export const createRequestTracker = (requestId, floorSeq) => ({
  floorSeq,
  requestId: String(requestId),
  /** 已 turn/start 但未 turn/end 的 turn 号（有序）。 */
  openTurns: [],
  /** 匹配到本请求的 turn 号（由 rpcId 匹配时那一刻的未闭合 turn 决定）。 */
  turn: undefined,
  sawRequest: false,
  text: '',
  /**
   * **只记录"真正产生了效果"的事件 seq**（建立 turn 关联 / 追加自己 turn 的文字 / 收尾 / 记录 turn/start）。
   * 当时因为"还不知道自己那个 turn"而无法使用的事件**不**标记——后续从完整日志回填时它们必须能被重新消费
   * （否则快照缺前半段就会永久丢掉答案）。
   */
  usedSeqs: new Set(),
  /**
   * 绑定到自己的 turn **之前**看到的助手文本（seq 升序回填）。
   * 不能丢（快照缺前半段时会永久丢答案），也不能在回读时按"到达顺序"追加（会倒序/重复）。
   */
  deferred: [],
  /** 本请求的 user/message 所在 seq（回填助手文本的下界；未见到时保持 undefined）。 */
  requestSeq: undefined,
  end: undefined,
  lastSeq: 0,
})

const dataOf = (event) => (event.data !== undefined && event.data !== null && typeof event.data === 'object' ? event.data : {})

/**
 * **官方日志的 fresh 证据**（第四轮 B/C/E）：只读事件序列，不看任何缓存状态。
 *  - `openTurns(events)`：按出现顺序列出仍未结束的 turn（turn/start 入、对应 turn/end 出）。
 *  - `currentOpenTurn(events)`：最后一个仍未结束的 turn（= 真实"当前开放回合"），没有则 null。
 *  - `turnHasEnded(events, turn)`：该 turn 是否已经收到 turn/end。
 *  - `findRequestEvidence(events, requestId)`：该 rpcId 的 user/message 落在哪个 turn（含 seq）。
 */
export const openTurnsOf = (events) => {
  const open = []
  if (!Array.isArray(events)) return open
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = dataOf(event)
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (event.type === 'turn/start' && turn !== undefined) { if (!open.includes(turn)) open.push(turn); continue }
    if (event.type === 'turn/end' && turn !== undefined) {
      const index = open.indexOf(turn)
      if (index >= 0) open.splice(index, 1)
    }
  }
  return open
}

export const currentOpenTurn = (events) => {
  const open = openTurnsOf(events)
  return open.length === 0 ? null : open[open.length - 1]
}

export const turnHasEnded = (events, turn) => {
  if (!Array.isArray(events) || !Number.isInteger(turn)) return false
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = dataOf(event)
    if (event.type === 'turn/end' && data.turn === turn) return true
  }
  return false
}

/** 该 rpcId 的 user/message 在日志里的位置：`{seq, turn}`（turn = 它所在的那个开放回合；不明则 null）。 */
export const findRequestEvidence = (events, requestId) => {
  if (!Array.isArray(events) || typeof requestId !== 'string' || requestId === '') return null
  const open = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = dataOf(event)
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (event.type === 'turn/start' && turn !== undefined) { if (!open.includes(turn)) open.push(turn); continue }
    if (event.type === 'turn/end' && turn !== undefined) {
      const index = open.indexOf(turn)
      if (index >= 0) open.splice(index, 1)
      continue
    }
    if (event.type !== 'user/message') continue
    const source = data.source !== undefined && data.source !== null && typeof data.source === 'object' ? data.source : {}
    if (source.rpcId !== requestId) continue
    const enclosing = typeof data.turn === 'number' ? data.turn : (open.length > 0 ? open[open.length - 1] : null)
    return { seq: typeof event.seq === 'number' ? event.seq : undefined, turn: enclosing }
  }
  return null
}

/**
 * 一次性把"绑定前"的助手文本按 seq 升序补进 `text`（第四轮修正 E/D）：
 *  - **批内/跨回放去重**：已经用过的 seq 绝不重复追加（同一缺前快照喂两遍不能变成 OWNOWN）；
 *  - **按 turn 过滤**：明确属于别的 turn 的文本丢弃（不能把另一个回合的 FOREIGN 记到自己头上）；
 *  - **只在"自己的 user/message 之后"**（requestSeq 下界），否则同 turn 里更早请求的文本会张冠李戴。
 * 不能用"把所有未知 turn 事件一律提前标记 used"来简化——那会破坏缺前半段快照的合法回填。
 */
const flushDeferred = (tracker) => {
  if (!Array.isArray(tracker.deferred) || tracker.deferred.length === 0) return
  const pending = tracker.deferred.slice().sort((a, b) => a.seq - b.seq)
  tracker.deferred = []
  const requestSeq = Number.isInteger(tracker.requestSeq) ? tracker.requestSeq : -1
  for (const item of pending) {
    if (tracker.usedSeqs.has(item.seq)) continue                  // 批内/跨回放去重
    tracker.usedSeqs.add(item.seq)
    if (item.turn !== undefined && item.turn !== tracker.turn) continue   // 明确属于别的回合 → 丢弃
    if (item.seq < requestSeq) continue                           // 请求之前的文本不属于本请求
    tracker.text += item.text
  }
}

/**
 * 消费一条会话事件。返回 `'settled'`（本请求的 turn 已结束）/ `'progress'` / `'ignored'`。
 */
export const consumeSessionEvent = (tracker, event) => {
  if (tracker === undefined || tracker === null) return 'ignored'
  if (Number.isInteger(tracker.floorSeq) && Number.isInteger(event?.seq) && event.seq <= tracker.floorSeq) return 'ignored'
  if (event === null || typeof event !== 'object') return 'ignored'
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  if (seq !== undefined) {
    if (tracker.usedSeqs.has(seq)) return 'ignored'          // 已经用过的效果不重复施加
    tracker.lastSeq = Math.max(tracker.lastSeq, seq)
  }
  const markUsed = () => { if (seq !== undefined) tracker.usedSeqs.add(seq) }
  const data = dataOf(event)
  if (event.type === 'turn/start') {
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (turn !== undefined && !tracker.openTurns.includes(turn)) tracker.openTurns.push(turn)
    markUsed()
    return 'ignored'
  }
  if (event.type === 'user/message') {
    const source = data.source !== undefined && data.source !== null && typeof data.source === 'object' ? data.source : {}
    if (typeof source.rpcId !== 'string' || source.rpcId !== tracker.requestId) return 'ignored'
    tracker.sawRequest = true
    if (seq !== undefined && !Number.isInteger(tracker.requestSeq)) tracker.requestSeq = seq   // 本请求消息所在的 seq（回填下界）
    if (tracker.turn === undefined) {
      // user/message 没有 data.turn：归到此刻仍未闭合的那个 turn（有 data.turn 时以它为准）
      const fallback = tracker.openTurns.length > 0 ? tracker.openTurns[tracker.openTurns.length - 1] : undefined
      tracker.turn = typeof data.turn === 'number' ? data.turn : fallback
    }
    // 只有真的建立了 turn 关联才算"用过"；没有未闭合 turn 时留待回填。
    if (tracker.turn !== undefined) {
      markUsed()
      flushDeferred(tracker)                                // 按 seq 顺序补上"绑定前"的助手文本（且只补一次）
    }
    return 'progress'
  }
  if (event.type === 'assistant/message') {
    const text = assistantTextOf(event)
    if (text === '') return 'ignored'
    if (tracker.turn === undefined) {
      // 还不知道自己的 turn：**排队等待按 seq 顺序回填**（不能直接丢，也不能在回读时才追加——
      // 那会把更早的文本接到更晚的文本后面，root 复现过 AFTER → AFTER|BEFORE 的倒序）。
      // 同时记下事件自带的 turn（若官方给了），回填时据此丢弃别的回合的文本；同一 seq 只入队一次
      // （同一"缺前快照"喂两遍不得变成 OWNOWN）。
      if (seq !== undefined && !tracker.deferred.some((item) => item.seq === seq)) {
        tracker.deferred.push({ seq, turn: typeof data.turn === 'number' ? data.turn : undefined, text })
      }
      return 'ignored'
    }
    if (typeof data.turn === 'number' && data.turn !== tracker.turn) {
      markUsed()                                            // 明确不是我们的 turn：用掉，避免反复评估
      return 'ignored'
    }
    tracker.text += text
    markUsed()
    return 'progress'
  }
  if (event.type === 'turn/end') {
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (turn !== undefined) tracker.openTurns = tracker.openTurns.filter((t) => t !== turn)
    if (tracker.turn === undefined || turn !== tracker.turn) {
      // 不是我们的回合：**不标记**，等自己那个 turn 绑定后若还有对应结束仍要能收到。
      return 'ignored'
    }
    const reason = data.reason !== undefined && data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
    const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
    tracker.end = { kind, reason, seq }
    markUsed()
    return 'settled'
  }
  return 'ignored'
}

/**
 * follow 开场的 snapshot 帧：`{type:'snapshot', records:[{type:'event', event:{…}}], …}`。
 * **不能把 snapshot 整个丢掉**——快任务可能在派发与订阅之间就已经跑完，答案只在这个快照里。
 */
export const consumeSnapshotFrame = (tracker, frame) => {
  const records = frame !== null && frame !== undefined && Array.isArray(frame.records)
    ? frame.records
    : (frame !== null && frame !== undefined && Array.isArray(frame.events) ? frame.events : [])
  let last = 'ignored'
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const event = record.type === 'event' && record.event !== undefined && record.event !== null
      ? record.event
      : (typeof record.type === 'string' && record.seq !== undefined ? record : undefined)
    if (event === undefined) continue
    const outcome = consumeSessionEvent(tracker, event)
    if (outcome === 'settled') return 'settled'
    if (outcome === 'progress') last = 'progress'
  }
  return last
}

/** 由 tracker 得出终态结论：只有 completed 算成功；其他 kind 明确失败；没有证据=未确认。 */
export const turnOutcome = (end) => {
  if (end === undefined || end === null) return { ok: false, unconfirmed: true, kind: 'unconfirmed' }
  if (end.kind === SUCCESS_TURN_END) return { ok: true, unconfirmed: false, kind: end.kind }
  return { ok: false, unconfirmed: false, kind: end.kind }
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
    // session 语义自带工作目录：混用会让人以为还能控制它。
    // **模型例外**（第五轮模型路由契约）：session 目标**接受** model/provider/modelFallback——扁平写法
    // （sessionId+model）与 target.kind='session'+model 必须语义一致，两者都由任务级路由策略处理。
    for (const [field, value] of [['cwd', raw.cwd], ['lane', raw.lane]]) {
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

/** 去空白后的字符 bigram 集合（CJK 友好：不需要分词）。 */
const bigramsOf = (value) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, '') : ''
  const out = new Set()
  if (text.length === 1) out.add(text)
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2))
  return out
}

/** 查询里的 bigram 有多少比例出现在标题里（0..1）。 */
export const titleSimilarity = (query, title) => {
  const q = bigramsOf(query)
  const t = bigramsOf(title)
  if (q.size === 0 || t.size === 0) return 0
  let shared = 0
  for (const gram of q) if (t.has(gram)) shared++
  return shared / q.size
}

/**
 * `session-query-empty` 时给出的"近似候选"。
 *
 * 起因是一个真实事故：调用方搜「量化框架」没命中，又**没有别的办法确认标题**，于是
 * 发了一条占位消息去"探测命中"——那条消息落进了用户自己的会话并跑成回合，污染了
 * 对话。修法是不给"探测"留动机：查询落空时直接回一批候选标题（同 bigram 相似度排
 * 序，无相似度的按最近更新补位），调用方靠只读信息就能改词重查。
 */
export const rankTitleCandidates = (query, summaries, limit = 5) => {
  const list = Array.isArray(summaries) ? summaries : []
  const scored = []
  for (const summary of list) {
    if (summary === null || typeof summary !== 'object') continue
    if (typeof summary.sessionId !== 'string' || summary.sessionId === '') continue
    const title = typeof summary.title === 'string' && summary.title !== '' ? summary.title : ''
    const updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
    scored.push({ sessionId: summary.sessionId, snippet: title, score: titleSimilarity(query, title), updatedAt })
  }
  const byRecency = (a, b) => b.updatedAt - a.updatedAt
  const related = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || byRecency(a, b))
  const rest = scored.filter((s) => s.score === 0).sort(byRecency)
  const bound = Math.max(1, Math.min(Number(limit) || 5, MAX_CANDIDATES))
  return [...related, ...rest].slice(0, bound).map((s) => ({
    sessionId: s.sessionId,
    snippet: s.snippet,
    score: Math.round(s.score * 1000) / 1000,
  }))
}

/** 任务在 HTTP 行上的回显：调用方一眼能看出这次是"新建"还是"接进哪个会话"。 */
export const taskResponse = (task) => {
  const out = { taskId: task.taskId, status: task.status, kind: task.kind }
  // 动态模型路由（M2）：回显实际选择/模式/是否允许降级（非秘密；不含任何凭据）。
  if (task.route !== undefined && task.route !== null && typeof task.route === 'object') out.route = task.route
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
  // delivered=true：prompt 已被目标会话接受（进了它的队列）。调用方据此知道
  // "别重发"——即便随后我们的观察超时并报错，消息也可能正在队列里等着跑。
  if (task.target !== undefined && task.target !== null && task.target.kind === 'session' && task.delivered === true) {
    out.delivered = true
  }
  // 来源关联（R1）：回显发起这次任务的 Codex 对话 id，便于跨回合按 origin+taskId 精确收取。
  if (typeof task.originThreadId === 'string' && task.originThreadId !== '') out.originThreadId = task.originThreadId
  // 委托审批的**非秘密**定位/期限（第三轮修正）：客户端等待循环必须能凭它做认证续租，
  // 否则慢模型超过初始租约就会把首个 ask 交回人工。raw key/摘要一律不出现在这里。
  if (typeof task.grantId === 'string' && task.grantId !== '') {
    out.grantId = task.grantId
    if (Number.isFinite(task.grantExpiresAt)) out.grantExpiresAt = task.grantExpiresAt
    if (Number.isFinite(task.grantLeaseUntil)) out.grantLeaseUntil = task.grantLeaseUntil
  }
  // 投递控制（第四轮）：回显投递模式与父/回执关系（非秘密），让调用方能区分"排队任务"与"补充回执"。
  if (task.target !== undefined && task.target !== null && task.target.kind === 'session') {
    const mode = task.requestedMode !== undefined ? task.requestedMode : task.deliver
    if (mode !== undefined) out.deliver = mode
    if (typeof task.parentTaskId === 'string' && task.parentTaskId !== '') out.parentTaskId = task.parentTaskId
    if (typeof task.receiptState === 'string' && task.receiptState !== '') out.receiptState = task.receiptState
    if (Number.isInteger(task.observedTurn)) out.observedTurn = task.observedTurn
    if (Number.isInteger(task.expectedTurn)) out.expectedTurn = task.expectedTurn
    if (typeof task.resultScope === 'string' && task.resultScope !== '') out.resultScope = task.resultScope
  }
  return out
}
