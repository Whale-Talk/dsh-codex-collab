/**
 * session-target.mjs 的单测：纯函数，不需要 DSH 运行时。
 * 跑法: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REASONS,
  MAX_CANDIDATES,
  textOfBlocks,
  assistantTextOf,
  baselineOf,
  extractNewAssistantText,
  classifyTarget,
  selectSession,
  mapControllerError,
  taskResponse,
} from '../harness/session-target.mjs'

// ---------------------------------------------------------------- 目标判定
test('classifyTarget: 不带 target 时保持 0.1.1 的 worker 行为', () => {
  const r = classifyTarget({ cwd: 'E:\\proj', lane: 'backend', model: 'fast' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.target, { kind: 'worker', cwd: 'E:\\proj', lane: 'backend' })
  assert.equal(r.deliver, 'queue')
  assert.deepEqual(r.notes, [])
})

test('classifyTarget: 显式 worker target', () => {
  const r = classifyTarget({ target: { kind: 'worker', cwd: '/tmp/x', lane: 'ui' } })
  assert.equal(r.ok, true)
  assert.equal(r.target.kind, 'worker')
  assert.equal(r.target.lane, 'ui')
})

test('classifyTarget: worker target 里混 session 字段会被拒', () => {
  const r = classifyTarget({ target: { kind: 'worker', sessionId: 'abc' } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASONS.INVALID_TARGET)
})

test('classifyTarget: session 目标接受 sessionId 或 query', () => {
  const byId = classifyTarget({ target: { kind: 'session', sessionId: ' session-1 ' } })
  assert.equal(byId.ok, true)
  assert.equal(byId.target.sessionId, 'session-1')
  assert.equal(byId.deliver, 'queue')

  const byQuery = classifyTarget({ target: { kind: 'session', query: ' 按文档启动OKX ' } })
  assert.equal(byQuery.ok, true)
  assert.equal(byQuery.target.query, '按文档启动OKX')
})

test('classifyTarget: session 目标必须恰好给一个定位方式', () => {
  assert.equal(classifyTarget({ target: { kind: 'session' } }).reason, REASONS.INVALID_TARGET)
  assert.equal(classifyTarget({ target: { kind: 'session', sessionId: 'a', query: 'b' } }).reason, REASONS.INVALID_TARGET)
  assert.equal(classifyTarget({ target: { kind: 'nope' } }).reason, REASONS.INVALID_TARGET)
})

test('classifyTarget: session 目标不许混 cwd/lane/model/commit', () => {
  for (const extra of [{ cwd: 'E:\\x' }, { lane: 'main' }, { model: 'fast' }, { commit: true }]) {
    const r = classifyTarget({ target: { kind: 'session', sessionId: 's' }, ...extra })
    assert.equal(r.ok, false, JSON.stringify(extra))
    assert.equal(r.reason, REASONS.INVALID_TARGET)
  }
})

test('classifyTarget: deliver 只认 queue/steer', () => {
  assert.equal(classifyTarget({ target: { kind: 'session', sessionId: 's' }, deliver: 'steer' }).deliver, 'steer')
  assert.equal(classifyTarget({ target: { kind: 'session', sessionId: 's' }, deliver: 'now' }).reason, REASONS.INVALID_TARGET)
})

test('classifyTarget: 扁平 sessionId/sessionQuery（MCP 书写）', () => {
  const r = classifyTarget({ instruction: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.target.kind, 'session')
  assert.equal(r.target.sessionId, 's1')
  assert.equal(classifyTarget({ sessionId: 'a', sessionQuery: 'b' }).reason, REASONS.INVALID_TARGET)
  assert.equal(classifyTarget({ sessionQuery: 'b', cwd: 'E:\\x' }).reason, REASONS.INVALID_TARGET)
})

test('classifyTarget: session 目标会说明 history 被忽略', () => {
  const r = classifyTarget({ target: { kind: 'session', sessionId: 's' }, history: [{ role: 'user', text: 'x' }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.notes, ['history ignored for session targets'])
})

// ------------------------------------------------------------ 候选挑选
test('selectSession: 显式 id 直接赢，不查结果', () => {
  const r = selectSession([], { sessionId: 'wanted' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'wanted')
})

test('selectSession: 0 条 → session-query-empty', () => {
  const r = selectSession([], { query: '无此会话' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASONS.QUERY_EMPTY)
  assert.deepEqual(r.candidates, [])
})

test('selectSession: 唯一命中才动手', () => {
  const r = selectSession([{ sessionId: 'a', snippet: '按文档启动OKX策略实验计划' }], { query: 'OKX' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'a')
  assert.equal(r.snippet, '按文档启动OKX策略实验计划')
})

test('selectSession: 多条命中 → 返回候选而不是猜第一条', () => {
  const hits = Array.from({ length: 15 }, (_, i) => ({ sessionId: 's' + i, snippet: 'hit ' + i }))
  const r = selectSession(hits, { query: 'hit' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASONS.AMBIGUOUS)
  assert.equal(r.candidates.length, MAX_CANDIDATES)
  assert.match(r.message, /15 sessions matched/)
})

test('selectSession: 忽略残缺命中项', () => {
  const r = selectSession([{ snippet: 'no id' }, { sessionId: 'good', snippet: 'x' }], { query: 'x' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'good')
})

// -------------------------------------------------- RemoteError → reason
test('mapControllerError: 四个 RemoteError 码各有稳定 reason', () => {
  assert.equal(mapControllerError({ code: 'session/not-found' }), REASONS.NOT_FOUND)
  assert.equal(mapControllerError({ code: 'session/agent-busy' }), REASONS.BUSY)
  assert.equal(mapControllerError({ code: 'session/writer-held' }), REASONS.WRITER_HELD)
  assert.equal(mapControllerError({ code: 'gateway/internal' }), REASONS.GATEWAY_INTERNAL)
  assert.equal(mapControllerError({ code: 'gateway/bad-request' }), REASONS.BAD_REQUEST)
  assert.equal(mapControllerError({ cause: { code: 'session/writer-held' } }), REASONS.WRITER_HELD)
})

test('mapControllerError: 未知错误仍然落到稳定码，不泄露实现细节', () => {
  assert.equal(mapControllerError(new Error('boom')), REASONS.DISPATCH_FAILED)
  assert.equal(mapControllerError(undefined), REASONS.DISPATCH_FAILED)
  assert.equal(mapControllerError({ code: 'something/else' }), REASONS.DISPATCH_FAILED)
})

// ------------------------------------------------------------ 文本提取
test('textOfBlocks / assistantTextOf: 嵌套 content 与事件形状', () => {
  assert.equal(textOfBlocks([{ type: 'text', text: 'a' }, { type: 'text', content: [{ type: 'text', text: 'b' }] }]), 'ab')
  assert.equal(textOfBlocks(undefined), '')
  assert.equal(assistantTextOf({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }), 'hi')
  assert.equal(assistantTextOf({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'flat' }] } }), 'flat')
  assert.equal(assistantTextOf({ type: 'user/message', data: { content: [{ type: 'text', text: 'ignored' }] } }), '')
})

test('baselineOf + extractNewAssistantText: 只回报基线之后的新文本', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '旧指令' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
  ]
  const baseline = baselineOf(events)
  assert.deepEqual(baseline, { count: 2, textLen: 3 })

  const grown = events.concat([
    { type: 'user/message', data: { content: [{ type: 'text', text: '新指令' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回复' }] } } },
  ])
  const extracted = extractNewAssistantText(grown, baseline)
  assert.equal(extracted.text, '新回复')
  assert.equal(extracted.total, '旧回复新回复')
  assert.deepEqual(extracted.baseline, { count: 4, textLen: 6 })
})

test('extractNewAssistantText: 没有新文本时返回空串', () => {
  const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }]
  const baseline = baselineOf(events)
  const extracted = extractNewAssistantText(events, baseline)
  assert.equal(extracted.text, '')
  assert.deepEqual(extracted.baseline, baseline)
})

// ------------------------------------------------------------ 响应回显
test('taskResponse: worker 与 session 各自回显目标，并带上 notes', () => {
  const worker = taskResponse({ taskId: 't1', status: 'accepted', kind: 'task', cwd: 'E:\\p', lane: 'main' })
  assert.deepEqual(worker.target, { kind: 'worker', cwd: 'E:\\p', lane: 'main' })

  const session = taskResponse({
    taskId: 't2', status: 'accepted', kind: 'task', deliver: 'steer',
    target: { kind: 'session', sessionId: 'session-8d481ad9', snippet: '按文档启动OKX策略实验计划' },
    notes: ['history ignored for session targets'],
  })
  assert.deepEqual(session.target, { kind: 'session', sessionId: 'session-8d481ad9', deliver: 'steer', snippet: '按文档启动OKX策略实验计划' })
  assert.deepEqual(session.notes, ['history ignored for session targets'])
})
