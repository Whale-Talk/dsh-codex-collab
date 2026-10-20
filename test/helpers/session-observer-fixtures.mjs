// Offline test primitives. No production I/O, SDK assumptions, or private hub fields.
export const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

export const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

export const manualClock = (initial = 1000) => {
  let value = initial
  return { now: () => value, advance: (ms) => { value += ms; return value } }
}

export const turnStart = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } })
export const userMessage = (seq, turn, requestId) => ({
  seq, type: 'user/message', data: { turn, id: 'u-' + seq, role: 'user', source: { rpcId: requestId } },
})
export const assistantMessage = (seq, turn, text) => ({
  seq, type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
})
export const toolCall = (seq, turn, step, callId = 'call-1') => ({
  seq, type: 'tool/call', data: { turn, step, callId, name: 'read_file', arguments: { path: 'fixture.txt' } },
})
export const modelSelection = (seq, model = 'human-choice') => ({
  seq, type: 'model/selection', data: { provider: 'offline-provider', model },
})
export const turnEnd = (seq, turn, kind = 'completed') => ({
  seq, type: 'turn/end', data: { turn, reason: { kind } },
})

export const createCtx = () => {
  const handlers = new Map()
  const cleanups = []
  return {
    on(name, listener) {
      let listeners = handlers.get(name)
      if (listeners === undefined) handlers.set(name, listeners = new Set())
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(name, ...args) { for (const listener of [...(handlers.get(name) || [])]) listener(...args) },
    effect(run) { const cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); handlers.clear() },
    listenerCount() { return [...handlers.values()].reduce((n, listeners) => n + listeners.size, 0) },
  }
}

// A follow source that can be paused, ended, or rejected without wall-clock sleeps.
export const createAsyncQueue = () => {
  const values = []
  const waiters = []
  let ended = false
  let failure
  const end = () => {
    ended = true
    for (const waiter of waiters.splice(0)) waiter.resolve({ done: true })
  }
  return {
    push(value) {
      if (ended) return false
      const waiter = waiters.shift()
      if (waiter === undefined) values.push(value)
      else waiter.resolve({ value, done: false })
      return true
    },
    end,
    fail(error = new Error('offline source disconnected')) {
      failure = error
      ended = true
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
    [Symbol.asyncIterator]() { return this },
    next() {
      if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false })
      if (failure !== undefined) return Promise.reject(failure)
      if (ended) return Promise.resolve({ done: true })
      const waiter = deferred()
      waiters.push(waiter)
      return waiter.promise
    },
    return() { end(); return Promise.resolve({ done: true }) },
  }
}

// Captures a read result when the read starts, then optionally holds its completion.
// This distinction is what reproduces stale in-flight reads during approval decisions.
export const createReadProbe = () => {
  const holds = []
  const allHolds = new Set()
  const calls = []
  const active = new Map()
  const peaks = new Map()
  return {
    calls,
    holdNext(sessionId) {
      const started = deferred()
      const resumed = deferred()
      const hold = { sessionId, started, resumed }
      holds.push(hold)
      allHolds.add(hold)
      return { started: started.promise, release: () => resumed.resolve(), reject: (error) => resumed.reject(error) }
    },
    async read(sessionId, kind, capture) {
      const result = structuredClone(capture())
      const record = { sessionId, kind, result }
      calls.push(record)
      const count = (active.get(sessionId) || 0) + 1
      active.set(sessionId, count)
      peaks.set(sessionId, Math.max(peaks.get(sessionId) || 0, count))
      try {
        const index = holds.findIndex((hold) => hold.sessionId === undefined || hold.sessionId === sessionId)
        if (index >= 0) {
          const [hold] = holds.splice(index, 1)
          hold.started.resolve(record)
          try { await hold.resumed.promise } finally { allHolds.delete(hold) }
        }
        return result
      } finally {
        active.set(sessionId, (active.get(sessionId) || 1) - 1)
      }
    },
    count(kind, sessionId) { return calls.filter((call) => (kind === undefined || call.kind === kind) && (sessionId === undefined || call.sessionId === sessionId)).length },
    peak(sessionId) { return peaks.get(sessionId) || 0 },
    inFlight(sessionId) { return active.get(sessionId) || 0 },
    releaseAllHolds() {
      for (const hold of allHolds) hold.resumed.resolve()
      allHolds.clear()
      holds.length = 0
    },
  }
}

export const latestCallStep = (events, callId = 'call-1') => {
  if (!Array.isArray(events)) return null
  let found = null
  for (const event of events) if (event.type === 'tool/call' && event.data?.callId === callId) found = event.data.step
  return found
}
