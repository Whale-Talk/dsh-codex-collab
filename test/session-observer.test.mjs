import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import {
  createCtx, createReadProbe, createAsyncQueue, flush, manualClock,
  turnStart, userMessage, assistantMessage, toolCall, modelSelection, turnEnd,
  latestCallStep,
} from './helpers/session-observer-fixtures.mjs'

import { createSessionObservationHub } from '../harness/session-observer.mjs'

const fixture = ({ native = false, initial = [turnStart(0, 1)], maxEvidence, maxTailBytes } = {}) => {
  const ctx = createCtx()
  const clock = manualClock()
  const probe = createReadProbe()
  const histories = new Map([['s', structuredClone(initial)]])
  const objects = new Map()
  const streams = new Map()
  const follows = []
  const addresses = []
  const disposals = []
  if (native) objects.set('s', { id: 's', seq: initial.length ? initial.at(-1).seq + 1 : 0 })
  const cut = (id) => {
    const events = histories.get(id) || []
    return { events, cursor: events.length ? events.at(-1).seq : -1 }
  }
  const query = {
    async observeSession(id) {
      const snapshot = await probe.read(id, 'observe', () => cut(id))
      snapshot[Symbol.dispose] = () => disposals.push(id)
      return snapshot
    },
    async readSession(id) { return probe.read(id, 'full', () => cut(id)) },
  }
  const controller = {
    async *follow({ address }, signal) {
      const id = address.sessionId ?? address.childSessionId
      const stream = createAsyncQueue()
      streams.set(id, stream)
      follows.push(id)
      addresses.push(structuredClone(address))
      const abort = () => stream.end()
      signal.addEventListener('abort', abort, { once: true })
      try { yield* stream } finally { signal.removeEventListener('abort', abort) }
    },
  }
  const hub = createSessionObservationHub({ ctx, query: () => query, controller: () => controller, liveSession: (id) => objects.get(id), now: clock.now, ...(maxEvidence === undefined ? {} : { maxEvidence }), ...(maxTailBytes === undefined ? {} : { maxTailBytes }) })
  const append = (event, { id = 's', emitNative = native, emitFollow = false } = {}) => {
    if (!histories.has(id)) histories.set(id, [])
    histories.get(id).push(event)
    const object = objects.get(id)
    if (object) object.seq = event.seq + 1
    if (emitNative && object) ctx.emit('session/event', object, event)
    if (emitFollow) streams.get(id)?.push({ type: 'event', event })
  }
  const close = async () => {
    hub.close()
    probe.releaseAllHolds()
    for (const stream of streams.values()) stream.end()
    ctx.dispose()
    await flush()
  }
  return { ctx, clock, probe, query, histories, objects, streams, follows, addresses, disposals, hub, append, close }
}

test('native append warm-up: repeated evidence/ticks do not re-observe history', { timeout: 3000 }, async (t) => {
  const f = fixture({ native: true })
  t.after(f.close)
  await f.hub.capture('s')
  const reads = f.probe.count()
  const seen = []
  const releases = Array.from({ length: 8 }, () => f.hub.subscribe('s', { afterSeq: 0, onEvent: (event) => seen.push(event.seq) }))
  await flush()
  for (let seq = 1; seq <= 20; seq += 1) {
    f.append(seq % 2 ? toolCall(seq, 1, seq) : modelSelection(seq))
    const evidence = await f.hub.evidence('s')
    assert.ok(Array.isArray(evidence))
    await f.hub.refresh('s')
  }
  assert.equal(f.hub.healthy('s'), true)
  assert.equal(f.probe.count(), reads, 'healthy native source must not repeatedly observe old history')
  assert.equal(f.probe.count('full'), 0)
  assert.equal(f.follows.length, 0)
  assert.equal(seen.length, 8 * 20)
  for (const release of releases) release()
})

test('follow subscribers for one session share source and get one copy of events', { timeout: 3000 }, async (t) => {
  const f = fixture()
  t.after(f.close)
  await f.hub.capture('s')
  const logs = Array.from({ length: 8 }, () => [])
  const releases = logs.map((log) => f.hub.subscribe('s', { afterSeq: 0, onEvent: (event) => log.push(event.seq) }))
  await flush()
  assert.equal(f.follows.length, 1)
  f.streams.get('s').push({ type: 'snapshot', records: [] })
  await flush()
  assert.equal(f.hub.healthy('s'), true)
  const warmedReads = f.probe.count()
  for (let seq = 1; seq <= 12; seq += 1) {
    f.append(userMessage(seq, 1, 'request-' + seq), { emitFollow: true })
    await flush()
    await f.hub.since('s', seq - 1)
    await f.hub.refresh('s')
  }
  assert.equal(f.probe.count(), warmedReads, 'healthy shared follow must suppress timer-style background observations')
  for (const log of logs) assert.deepEqual(log, Array.from({ length: 12 }, (_, i) => i + 1))
  for (const release of releases) release()
})

test('concurrent capture waiters cannot overlap reads after waiting on an old refresh', { timeout: 3000 }, async (t) => {
  const f = fixture()
  t.after(f.close)
  const old = f.probe.holdNext('s')
  const refreshing = f.hub.refresh('s')
  await old.started
  const next = f.probe.holdNext('s')
  const captures = Array.from({ length: 6 }, () => f.hub.capture('s'))
  old.release()
  await flush()
  const peak = f.probe.peak('s')
  next.release()
  await Promise.all([refreshing, ...captures])
  assert.equal(peak, 1, 'all capture/refresh paths must share the same session in-flight gate')
})

test('fresh decision evidence cannot reuse a read cut started before the decision', { timeout: 3000 }, async (t) => {
  const f = fixture({ initial: [turnStart(0, 1), toolCall(1, 1, 1)] })
  t.after(f.close)
  const old = f.probe.holdNext('s')
  const refreshing = f.hub.refresh('s')
  await old.started
  f.append(toolCall(2, 1, 2))
  const afterFence = f.probe.holdNext('s')
  let decisionResolved = false
  const evidence = f.hub.evidence('s', { fresh: true }).then((events) => { decisionResolved = true; return events })
  old.release()
  await flush()
  assert.equal(decisionResolved, false, 'fresh operation must wait for its post-request evidence cut')
  assert.equal(f.probe.peak('s'), 1)
  afterFence.release()
  const events = await evidence
  await refreshing
  assert.equal(latestCallStep(events), 2)
})

test('follow snapshot with wrapped events repairs the subscription opening interval', { timeout: 3000 }, async (t) => {
  const f = fixture()
  t.after(f.close)
  await f.hub.capture('s')
  const seen = []
  f.hub.subscribe('s', { afterSeq: 0, onEvent: (event) => seen.push(event.seq) })
  await flush()
  const request = userMessage(1, 1, 'opening-rpc')
  const done = turnEnd(2, 1)
  f.append(request)
  f.append(done)
  f.streams.get('s').push({ type: 'snapshot', records: [{ type: 'event', event: request }, { type: 'event', event: done }] })
  await flush()
  assert.deepEqual(seen, [1, 2], 'events between initial cut and follow registration must not disappear')
  const evidence = await f.hub.evidence('s', { fresh: false })
  assert.ok(evidence.some((event) => event.type === 'turn/end' && event.seq === 2))
})

test('a sequence gap triggers recovery without skipping the missing records', { timeout: 3000 }, async (t) => {
  const f = fixture()
  t.after(f.close)
  await f.hub.capture('s')
  const seen = []
  f.hub.subscribe('s', { afterSeq: 0, onEvent: (event) => seen.push(event.seq) })
  await flush()
  f.streams.get('s').push({ type: 'snapshot', records: [] })
  await flush()
  f.append(userMessage(1, 1, 'gap-rpc'))
  f.append(assistantMessage(2, 1, 'owned result'))
  f.append(turnEnd(3, 1), { emitFollow: true })
  await flush()
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(f.probe.peak('s'), 1)
})

test('close during held observation prevents late callbacks and state resurrection', { timeout: 3000 }, async (t) => {
  const f = fixture({ native: true })
  t.after(f.close)
  const hold = f.probe.holdNext('s')
  const callbacks = []
  f.hub.subscribe('s', { onEvent: (event) => callbacks.push(event.seq), onUncertain: () => callbacks.push('uncertain') })
  await hold.started
  f.hub.close()
  hold.release()
  await flush()
  f.append(toolCall(1, 1, 2))
  const reads = f.probe.count()
  assert.equal(await f.hub.evidence('s'), null)
  assert.equal(await f.hub.capture('s'), null)
  await flush()
  assert.deepEqual(callbacks, [])
  assert.equal(f.probe.count(), reads)
  assert.equal(f.hub.status().sessions, 0, 'public calls after close must not re-create retained session state')
})

test('failed background reads back off while a fresh decision may still retry', { timeout: 3000 }, async (t) => {
  const f = fixture()
  t.after(f.close)
  const original = f.query.observeSession
  f.query.observeSession = async (id) => { await original(id); throw new Error('offline fixture read unavailable') }
  assert.equal(await f.hub.refresh('s'), null)
  const firstCalls = f.probe.count()
  for (let i = 0; i < 20; i += 1) await f.hub.refresh('s', { fresh: false })
  const callsBeforeDecision = f.probe.count()
  assert.ok(callsBeforeDecision <= firstCalls + 1, 'same-clock background demands must not start one failed read per demand')
  assert.equal(await f.hub.evidence('s', { fresh: true }), null)
  assert.ok(f.probe.count() > callsBeforeDecision, 'a security-sensitive fresh request may retry despite background cooldown')
  assert.equal(f.probe.peak('s'), 1)
})

test('same-value model re-selection advances sequence without per-request history reads', { timeout: 3000 }, async (t) => {
  const f = fixture({ native: true, initial: [turnStart(0, 1), modelSelection(1, 'same-value')] })
  t.after(f.close)
  await f.hub.capture('s')
  assert.deepEqual(await f.hub.latestSelectionSeq('s'), { ok: true, seq: 1 })
  const calls = f.probe.count()
  f.append(modelSelection(2, 'same-value'))
  for (let i = 0; i < 30; i += 1) assert.deepEqual(await f.hub.latestSelectionSeq('s'), { ok: true, seq: 2 })
  assert.equal(f.probe.count(), calls)
})

test('native events buffered during old observation arrive once after the cut', { timeout: 3000 }, async (t) => {
  const f = fixture({ native: true })
  t.after(f.close)
  const hold = f.probe.holdNext('s')
  const seen = []
  f.hub.subscribe('s', { afterSeq: 0, onEvent: (event) => seen.push(event.seq) })
  await hold.started
  f.append(userMessage(1, 1, 'buffered-rpc'))
  f.append(assistantMessage(2, 1, 'buffered-own-result'))
  f.append(turnEnd(3, 1))
  hold.release()
  await flush()
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(f.hub.healthy('s'), true)
  const count = f.probe.count()
  await f.hub.refresh('s')
  assert.equal(f.probe.count(), count)
})

test('pruning retires idle sessions while preserving active subscriptions', { timeout: 3000 }, async (t) => {
  const f = fixture({ native: true })
  t.after(f.close)
  await f.hub.capture('s')
  const release = f.hub.subscribe('s', { afterSeq: 0 })
  await flush()
  for (let i = 0; i < 20; i += 1) await f.hub.evidence('idle-' + i)
  f.clock.advance(60_000)
  f.hub.prune()
  assert.equal(f.hub.status().sessions, 1)
  assert.equal(f.hub.healthy('s'), true)
  release()
  f.clock.advance(60_000)
  f.hub.prune()
  assert.equal(f.hub.status().sessions, 0)
})

test('large non-message payloads do not pin their bodies in replay tails', async t => {
  const f = fixture({ native: true, maxTailBytes: 1024 })
  t.after(f.close)
  await f.hub.refresh('s')
  const seen = []
  f.hub.subscribe('s', { afterSeq: 0, onEvent: event => seen.push(event.seq) })
  await flush()
  for (let seq = 1; seq <= 10; seq++) f.append({ seq, type: 'tool/result', data: { body: 'x'.repeat(1024 * 1024) } })
  assert.deepEqual(seen, [1,2,3,4,5,6,7,8,9,10])
  assert.ok(f.hub.status().tailBytes <= 1024)
  assert.equal(f.probe.count(), 1)
})

test('shared follow preserves exact subagent address on first connection and recovery', async t => {
  const f = fixture()
  t.after(f.close)
  const address = { kind: 'subagent', parentSessionId: 'owner', childSessionId: 's', mode: 'continuable' }
  f.hub.subscribe('s', { afterSeq: 0, address })
  await flush()
  assert.deepEqual(f.addresses, [address])
  f.streams.get('s').fail()
  await flush()
  await f.hub.since('s', 0)
  await flush()
  assert.deepEqual(f.addresses, [address, address])
})

test('an older query cut cannot roll back a continuous follow proof', async t => {
  const f = fixture({ initial: [turnStart(0, 1), toolCall(1, 1, 1)] })
  t.after(f.close)
  f.hub.subscribe('s', { afterSeq: 1 })
  await flush()
  f.streams.get('s').push({ type: 'snapshot', cursor: 1, records: [] })
  f.append(toolCall(2, 1, 2), { emitFollow: true })
  await flush()
  assert.equal(f.hub.healthy('s'), true)
  f.histories.get('s').pop() // Simulate a stale external cut, not an official mutable history.
  assert.equal(await f.hub.evidence('s'), null)
  assert.equal(f.hub.healthy('s'), false)
})

test('buffer overflow fails fresh proof closed and a later cut recovers every missing event', async t => {
  const f = fixture({ native: true, maxTailBytes: 1024 })
  t.after(f.close)
  const hold = f.probe.holdNext('s'), seen = []
  f.hub.subscribe('s', { afterSeq: 0, onEvent: event => seen.push(event.seq) })
  await hold.started
  for (let seq = 1; seq <= 8; seq++) f.append(toolCall(seq, 1, seq))
  assert.ok(f.hub.status().bufferedBytes <= 1024)
  hold.release()
  await flush()
  const proof = await f.hub.evidence('s')
  assert.equal(proof.at(-1).data.step, 8)
  assert.deepEqual(seen, [1,2,3,4,5,6,7,8])
  assert.equal(f.probe.peak('s'), 1)
})
