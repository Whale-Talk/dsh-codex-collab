/** Shared, bounded observation of session history. Never retain full message history. */
import { assistantTextOf } from './session-target.mjs'
const compact = (event) => {
  const d = event.data || {}
  const fields = {
    'turn/start': ['turn'], 'turn/end': ['turn', 'reason'],
    'tool/call': ['callId', 'turn', 'step'],
    'approval/asked': ['id', 'toolName', 'callId'],
    'approval/decided': ['id', 'outcome'],
    'user/message': ['turn', 'source'], 'model/selection': [],
  }[event.type]
  if (!fields) return null
  const data = {}
  for (const key of fields) {
    if (d[key] === undefined) continue
    data[key] = key === 'source' ? { rpcId: d.source?.rpcId }
      : key === 'reason' ? { kind: d.reason?.kind } : d[key]
  }
  return { seq: event.seq, type: event.type, data }
}
const replayEvent = (event) => {
  if (event.type !== 'assistant/message') return compact(event) || { seq: event.seq, type: event.type, data: {} }
  const text = assistantTextOf(event)
  return { seq: event.seq, type: event.type, data: { turn: event.data?.turn, step: event.data?.step, message: { content: [{ type: 'text', text }] } } }
}
const weight = (event) => JSON.stringify(event).length * 2 + 128

export const createSessionObservationHub = (options = {}) => {
  const entries = new Map()
  const counters = { reads: 0, observations: 0, events: 0, gaps: 0, failures: 0 }
  const maxEvidence = options.maxEvidence ?? 32768
  const now = options.now || Date.now
  let closed = false
  const maxTailBytes = options.maxTailBytes ?? 4 * 1024 * 1024
  const retain = (e, event) => {
    if (!e.listeners.size) return
    const value = replayEvent(event), bytes = weight(value)
    if (bytes > maxTailBytes) { e.tail = []; e.tailBytes = 0; return }
    e.tail.push(value); e.tailBytes = (e.tailBytes || 0) + bytes
    while (e.tail.length > 256 || e.tailBytes > maxTailBytes) e.tailBytes -= weight(e.tail.shift())
  }
  const query = () => typeof options.query === 'function' ? options.query() : options.query
  const live = (id) => { try { return options.liveSession?.(id) } catch { return null } }
  const entry = (id) => {
    if (!entries.has(id) && entries.size >= 32) {
      const idle = [...entries.values()].filter(e => !e.listeners.size && !e.inflight).sort((a,b) => a.touched - b.touched)[0]
      if (idle) { idle.stream?.abort(); entries.delete(idle.id) }
    }
    let e = entries.get(id)
    if (!e) { e = { id, cursor: -1, ready: false, evidence: [], overflow: false, tail: [], listeners: new Set(), buffered: [], reading: false, requested: 0, completed: 0, inflight: null, stream: null, connected: false, touched: now(), object: null }; if (!closed) entries.set(id, e) }
    e.touched = now()
    return e
  }
  const headMatches = (e) => {
    const s = live(e.id)
    return e.ready && s && s === e.object?.deref() && Number.isInteger(s.seq) && s.seq - 1 === e.cursor
  }
  const uncertain = (e) => { e.connected = false; for (const sub of e.listeners) sub.onUncertain?.() }
  const deliver = (e, event) => {
    for (const sub of [...e.listeners]) {
      if (sub.signal?.aborted || event.seq <= sub.afterSeq) continue
      sub.afterSeq = event.seq
      sub.onEvent?.(event)
    }
  }
  const accept = (e, event) => {
    if (closed || !event || !Number.isInteger(event.seq)) return
    if (e.reading || !e.ready) {
      const value = replayEvent(event), bytes = weight(value)
      if (e.buffered.length >= 1024 || (e.bufferBytes || 0) + bytes > maxTailBytes) {
        e.buffered = []; e.bufferBytes = 0; e.bufferOverflow = true; uncertain(e); return
      }
      if (!e.bufferOverflow) { e.buffered.push(value); e.bufferBytes = (e.bufferBytes || 0) + bytes }
      return
    }
    if (event.seq <= e.cursor) return
    if (event.seq !== e.cursor + 1) { counters.gaps++; e.ready = false; uncertain(e); accept(e, event); return }
    e.cursor = event.seq
    counters.events++
    const small = compact(event)
    if (small) { e.evidence.push(small); if (e.evidence.length > maxEvidence) { e.evidence.shift(); e.overflow = true } }
    retain(e, event)
    deliver(e, event)
  }
  const off = options.ctx?.on?.('session/event', (session, event) => {
    const id = session?.id ?? session?.header?.id
    const e = entries.get(id)
    if (!e || closed) return
    if (e.object?.deref() && e.object.deref() !== session) { e.ready = false; e.cursor = -1; uncertain(e) }
    e.object = new WeakRef(session)
    accept(e, event)
  }, { global: true })

  const read = async (e) => {
    const q = query()
    if (!q) return null
    let snapshot
    try {
      e.reading = true
      const object = live(e.id)
      if (typeof q.observeSession === 'function') { counters.observations++; snapshot = await q.observeSession(e.id, { projectionMode: 'none' }) }
      else { counters.reads++; snapshot = await q.readSession(e.id) }
      if (closed || !snapshot || !Array.isArray(snapshot.events)) return null
      const events = snapshot.events
      const cursor = Number.isInteger(snapshot.cursor) ? snapshot.cursor : (events.length ? events[events.length - 1].seq : -1)
      if (!Number.isInteger(cursor)) return null
      if (object && live(e.id) !== object) { uncertain(e); return null }
      if (cursor < e.cursor) { uncertain(e); return null }
      const previous = e.cursor
      e.evidence = []; e.overflow = false
      for (const event of events) {
        const small = compact(event)
        if (small) { e.evidence.push(small); if (e.evidence.length > maxEvidence) { e.evidence.shift(); e.overflow = true } }
      }
      e.cursor = cursor; e.ready = true; e.object = object ? new WeakRef(object) : e.object
      // A cold observation is borrowed, immutable SDK history. Release its cache lease immediately.
      e.tail = []; e.tailBytes = 0
      for (let i = Math.max(0, events.length - 256); i < events.length; i++) retain(e, events[i])
      for (const event of events) if (event.seq > previous) deliver(e, event)
      return { events, cursor }
    } catch { counters.failures++; e.failures = (e.failures || 0) + 1; e.retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(e.failures, 5)); uncertain(e); return null }
    finally {
      try { snapshot?.[Symbol.dispose]?.() } catch { /* release must not hide failure */ }
      e.reading = false
      const buffered = e.buffered; e.buffered = []; e.bufferBytes = 0
      if (e.bufferOverflow) { e.bufferOverflow = false; e.ready = false; uncertain(e) }
      buffered.sort((a,b) => a.seq - b.seq)
      for (const event of buffered) accept(e, event)
    }
  }
  const refreshEntry = async (e, fresh, force = false) => {
    if (closed) return null
    if (!fresh && !force && e.retryAt > now()) return null
    if (!force && headMatches(e)) return { cursor: e.cursor, evidence: e.overflow ? null : e.evidence }
    if (!force && !fresh && e.ready && e.connected) return { cursor: e.cursor, evidence: e.overflow ? null : e.evidence }
    const ticket = ++e.requested
    if (!e.inflight) {
      e.inflight = (async () => {
        let result = null
        while (!closed && e.completed < e.requested) {
          const through = e.requested
          result = await read(e)
          e.completed = through
          if (!result) { e.ready = false; break }
          e.failures = 0; e.retryAt = 0
        }
        return result
      })().finally(() => { e.inflight = null })
    }
    const result = await e.inflight
    // A query requested after an older read began needs a cut begun after its request.
    if (!closed && result && e.completed < ticket) return refreshEntry(e, true)
    return closed || !result || !e.ready ? null : { ...result, evidence: e.overflow ? null : e.evidence }
  }
  const startStream = (e) => {
    if (e.stream || closed || headMatches(e)) return
    const controller = new AbortController()
    e.stream = controller
    void (async () => {
      try {
        const service = typeof options.controller === 'function' ? options.controller() : options.controller
        if (!service?.follow) return
        for await (const frame of service.follow({ address: e.address || { kind: 'session', sessionId: e.id } }, controller.signal)) {
          if (closed || controller.signal.aborted) break
          if (frame.type === 'snapshot') {
            // The follow tail has no resume cursor. A missing business interval is repaired by query.
            const records = frame.records || []
            for (const record of records) accept(e, record?.type === 'event' ? record.event : record)
            if (!e.ready || (Number.isInteger(frame.cursor) && frame.cursor !== e.cursor)) await refreshEntry(e, true)
            e.connected = e.ready
          } else if (frame.type === 'event') { accept(e, frame.event); if (!e.ready) await refreshEntry(e, true) }
        }
      } catch { counters.failures++ }
      finally { if (e.stream === controller) { e.stream = null; uncertain(e) } }
    })()
  }
  const hub = {
    async refresh(id, { fresh = false } = {}) { return refreshEntry(entry(id), fresh) },
    async evidence(id, { fresh = true } = {}) { const e = entry(id); return await refreshEntry(e, fresh) && !e.overflow ? e.evidence : null },
    async latestSelectionSeq(id) { const events = await hub.evidence(id); if (!events) return { ok: false }; return { ok: true, seq: events.findLast(e => e.type === 'model/selection')?.seq ?? null } },
    async capture(id) { return readThrough(entry(id)) },
    async since(id, afterSeq, { fresh = false } = {}) {
      const e = entry(id)
      const result = await refreshEntry(e, fresh)
      if (!result) return null
      if (e.listeners.size) startStream(e)
      if (afterSeq >= e.cursor) return { events: [], cursor: e.cursor }
      if (result.events) return { events: result.events.filter(x => x.seq > afterSeq), cursor: result.cursor }
      if (e.tail.length && e.tail[0].seq <= afterSeq + 1) return { events: e.tail.filter(x => x.seq > afterSeq), cursor: e.cursor }
      const snap = await readThrough(e)
      return snap && { events: snap.events.filter(x => x.seq > afterSeq), cursor: snap.cursor }
    },
    subscribe(id, { afterSeq = -1, onEvent, onUncertain, signal, address } = {}) {
      const e = entry(id), sub = { afterSeq, onEvent, onUncertain, signal }
      if (closed || signal?.aborted) return () => {}
      if (address) {
        const normalized = address.kind === 'subagent'
          ? { kind: 'subagent', parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, mode: address.mode }
          : { kind: 'session', sessionId: address.sessionId }
        if (e.address && JSON.stringify(e.address) !== JSON.stringify(normalized)) { onUncertain?.(); return () => {} }
        e.address = normalized
      }
      e.listeners.add(sub)
      const release = () => { e.listeners.delete(sub); signal?.removeEventListener('abort', release); if (!e.listeners.size) { e.stream?.abort(); e.tail = []; e.tailBytes = 0 } }
      signal?.addEventListener('abort', release, { once: true })
      void hub.since(id, afterSeq).then(snap => { if (!snap || closed || !e.listeners.has(sub)) return; for (const event of snap.events) { if (event.seq > sub.afterSeq) { sub.afterSeq = event.seq; sub.onEvent?.(event) } }; startStream(e) })
      return release
    },
    healthy(id) { const e = entries.get(id); return !!e && (headMatches(e) || (e.ready && e.connected)) },
    prune() { for (const [id,e] of entries) if (!e.listeners.size && !e.inflight && now() - e.touched > 30000) { e.stream?.abort(); entries.delete(id) } },
    status() { return { ...counters, sessions: entries.size, tailBytes: [...entries.values()].reduce((n,e) => n + (e.tailBytes || 0), 0), bufferedBytes: [...entries.values()].reduce((n,e) => n + (e.bufferBytes || 0), 0) } },
    close() { closed = true; if (typeof off === 'function') off(); for (const e of entries.values()) { e.stream?.abort(); e.listeners.clear(); e.evidence = []; e.tail = []; e.buffered = [] }; entries.clear() },
  }
  // Force a full borrowed cut for legacy result extraction, still serialized with all other reads.
  const readThrough = (e) => refreshEntry(e, true, true)
  return hub
}
