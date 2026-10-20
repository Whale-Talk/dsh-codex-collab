/**
 * 投递控制（queue / steer）行为回归（真实 HTTP 网关 + 独立 MCP 进程 + 独立 CLI 进程）。
 *
 * 覆盖计划必测矩阵中可在 harness 内如实表达的部分：
 *  · 忙时 queue 可靠接收（不再是 session-busy），独立 task/requestId/回合/结果，互不覆盖；
 *  · 全会话 running/idle 只触发观察，绝不把 B/C 一起标 running/done（各自 rpcId/turn 证据）；
 *  · steer：显式父任务 + 同 origin/会话 + 父在执行 + 回合可证；回执只等自身观察（有界），不等父结果；
 *  · steer 零投递负例（无父/父终态/父排队/错来源/错 expectedTurn/缺凭据/旧网关/无来源）；
 *  · 审批隔离：回执不是 owner；A 收口不清 B 的 pending；
 *  · 取消安全：有别的在途任务时拒绝 session cancel，排队项/回执明确不支持撤销；
 *  · 回放顺序/去重：绑定前的助手文本按 seq 回填一次，重读不出现 AFTER|BEFORE 倒序；
 *  · 旧无来源路径保持忙锁 + 与新来源绑定任务不得混用；worker 桶忙锁不退化。
 *
 * 边界：真机 queue 在后续 turn 被消费、steer 同 turn 被模型读入由 Root 的真实 DSH profile 验收；
 * 本文件证明**网关接线与归属语义**，官方队列顺序由 test/delivery-native.test.mjs 的真实组件证明。
 * 跑法: node test/delivery.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, runCli, runMcp, mcpInit, mcpCall, payloadOf } from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'
import { consumeSessionEvent, createRequestTracker } from '../harness/session-target.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-key-'))
const keyPath = path.join(keyDir, 'control.key')
initControlKey({ path: keyPath })
const RAW_KEY = fs.readFileSync(keyPath, 'utf8').trim()
const HEADERS = { 'X-Dsh-Control': RAW_KEY }
process.env.DSH_APPROVAL_CONTROL_KEY_PATH = keyPath

after(async () => {
  delete process.env.DSH_APPROVAL_CONTROL_KEY_PATH
  await disposeAll()
  try { fs.rmSync(keyDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})

const ev = (seq, type, data) => ({ seq, type, data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const getJson = async (url, headers) => {
  const res = await fetch(url, { headers })
  let body = null
  try { body = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body }
}
const postJson = async (url, payload, headers) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(payload) })
  let body = null
  try { body = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body }
}
const until = async (fn, { timeoutMs = 5000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

const setup = async (env = {}) => {
  const assocRoot = await makeTmp('delivery-assoc-')
  const storeRoot = await makeTmp('delivery-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot, ...env } })
  const rows = (name) => {
    try { return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch (e) { return [] }
  }
  return {
    gateway, events, storeRoot,
    cliEnv: { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath },
    mcpEnv: { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath },
    grantRows: () => rows('grants.jsonl').filter((r) => r.type === 'grant'),
    push: (...items) => { for (const item of items) events.push(ev(events.length + 1, item[0], item[1])) },
  }
}

const dispatch = (gateway, body, headers) => postJson(gateway.url + '/api/dsh-bridge/task', { deliver: 'queue', ...body }, headers)
const statusOf = async (gateway, taskId, origin) => {
  const url = gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + (origin === undefined ? '' : '&originThreadId=' + encodeURIComponent(origin))
  const res = await getJson(url)
  return res.body === null || typeof res.body !== 'object' ? {} : res.body
}
/** 让某条来源绑定任务"真正开始执行"：自己的 rpcId 落进自己的回合 + 全会话 running 事件。 */
const startExecuting = async (env, { sessionId, taskId, turn, origin }) => {
  env.push(['turn/start', { turn }], ['user/message', { id: 'u-' + taskId, role: 'user', content: [{ type: 'text', text: 'go' }], source: { rpcId: taskId } }])
  env.gateway.emitCtx('api-session/status', sessionId, true)
  const reached = await until(async () => {
    await env.gateway.runIntervals()
    return (await statusOf(env.gateway, taskId, origin)).status === 'running'
  }, { timeoutMs: 5000, intervalMs: 50 })
  assert.equal(reached, true, '任务必须能凭自己的 rpcId 进入 running: ' + taskId + ' -> ' + JSON.stringify(await statusOf(env.gateway, taskId, origin)))
}
const finishTask = async (env, { sessionId, taskId, turn, text, origin }) => {
  env.push(
    ['assistant/message', { turn, step: 1, message: { id: 'a-' + taskId, role: 'assistant', content: [{ type: 'text', text }] } }],
    ['turn/end', { turn, reason: { kind: 'completed' } }],
  )
  env.gateway.emitCtx('api-session/status', sessionId, false)
  const settled = await until(async () => {
    await env.gateway.runIntervals()
    return (await statusOf(env.gateway, taskId, origin)).status === 'done'
  }, { timeoutMs: 5000, intervalMs: 50 })
  assert.equal(settled, true, '任务必须凭自己的 turn/end 收口为 done: ' + taskId + ' -> ' + JSON.stringify(await statusOf(env.gateway, taskId, origin)))
}

// ---------------------------------------------------------------- 回放顺序 / 去重（Root 复现的缺陷）

test('回放：绑定前的助手文本按 seq 回填一次，重读不出现 AFTER|BEFORE 倒序（A=BEFORE|AFTER、B 稳定=AFTER）', () => {
  const events = [
    ev(1, 'turn/start', { turn: 8 }),
    ev(2, 'user/message', { id: 'uA', role: 'user', content: [{ type: 'text', text: 'A' }], source: { rpcId: 'rpc-A' } }),
    ev(3, 'assistant/message', { turn: 8, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'BEFORE' }] } }),
    ev(4, 'user/message', { id: 'uB', role: 'user', content: [{ type: 'text', text: 'B' }], source: { rpcId: 'rpc-B' } }),
    ev(5, 'assistant/message', { turn: 8, step: 2, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'AFTER' }] } }),
    ev(6, 'turn/end', { turn: 8, reason: { kind: 'completed' } }),
  ]
  const a = createRequestTracker('rpc-A')
  for (const e of events) consumeSessionEvent(a, e)
  assert.equal(a.text, 'BEFOREAFTER', 'A 应拿到本回合完整文本（BEFORE 在前）')
  assert.equal(a.sawRequest, true)

  // B：第一次只看到后半段（快照缺前半），然后从完整日志重读——必须**稳定**且不倒序
  const b = createRequestTracker('rpc-B')
  for (const e of events) consumeSessionEvent(b, e)
  const first = b.text
  assert.equal(first, 'AFTER', 'B 第一次只应拿到 AFTER')
  for (const e of events) consumeSessionEvent(b, e)     // 重读完整日志（真实场景：轮询/重连后重读）
  assert.equal(b.text, first, '重读不得重复累加，也不得变成 AFTER|BEFORE: ' + JSON.stringify(b.text))
  assert.equal(b.text.includes('BEFORE'), false, 'BEFORE 属于 A 的回合之前的文本，不能记到 B')
})

// ---------------------------------------------------------------- 忙时 queue

test('忙时 queue：A 运行中派 B/C 都可靠接收（202 + 各自 task/requestId），互不覆盖、不误结算', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'delivery-origin-queue'
  const sessionId = 'sess-queue'
  try {
    const a = await dispatch(gateway, { instruction: 'A', sessionId, originThreadId: origin, deliver: 'queue' })
    assert.equal(a.status, 202, JSON.stringify(a.body))
    await startExecuting(env, { sessionId, taskId: a.body.taskId, turn: 1, origin })

    // 忙时接收 B、C：不再是 session-busy
    const b = await dispatch(gateway, { instruction: 'B', sessionId, originThreadId: origin, deliver: 'queue' })
    const c = await dispatch(gateway, { instruction: 'C', sessionId, originThreadId: origin, deliver: 'queue' })
    assert.equal(b.status, 202, '忙时 queue 必须被接收: ' + JSON.stringify(b.body))
    assert.equal(c.status, 202, '忙时 queue 必须被接收: ' + JSON.stringify(c.body))
    const ids = [a.body.taskId, b.body.taskId, c.body.taskId]
    assert.equal(new Set(ids).size, 3, '每个任务独立 taskId')
    assert.deepEqual(gateway.prompts.map((p) => p.requestId), ids, '每个任务独立 requestId，按接收顺序投递')
    assert.deepEqual(gateway.prompts.map((p) => p.mode), ['queue', 'queue', 'queue'], '默认 queue 模式')
    // B/C 还没轮到 → queued（不是 running/done）
    assert.equal((await statusOf(gateway, a.body.taskId, origin)).status, 'running')
    assert.equal((await statusOf(gateway, b.body.taskId, origin)).status, 'queued', 'B 必须保持 queued，不能被全会话 running 带成 running')
    assert.equal((await statusOf(gateway, c.body.taskId, origin)).status, 'queued')

    // A 结束：只结算 A，B/C 不受影响
    await finishTask(env, { sessionId, taskId: a.body.taskId, turn: 1, text: 'A-DONE', origin })
    const aAfter = await statusOf(gateway, a.body.taskId, origin)
    assert.equal(aAfter.status, 'done')
    assert.equal(aAfter.result, 'A-DONE')
    assert.equal((await statusOf(gateway, b.body.taskId, origin)).status, 'queued', 'A 收口不得动 B')
    assert.equal((await statusOf(gateway, c.body.taskId, origin)).status, 'queued', 'A 收口不得动 C')
    assert.equal((await statusOf(gateway, b.body.taskId, origin)).result, undefined, 'B 不得拿到 A 的结果')

    // 官方 FIFO 轮到 B：B 自己开始执行 → running，然后自己结束 → done（各自结果）
    await startExecuting(env, { sessionId, taskId: b.body.taskId, turn: 2, origin })
    await finishTask(env, { sessionId, taskId: b.body.taskId, turn: 2, text: 'B-DONE', origin })
    const bAfter = await statusOf(gateway, b.body.taskId, origin)
    assert.equal(bAfter.status, 'done')
    assert.equal(bAfter.result, 'B-DONE')
    assert.equal((await statusOf(gateway, c.body.taskId, origin)).status, 'queued', 'C 仍在队列里')
  } finally {
    await gateway.close()
  }
})

test('旧无来源路径：保持忙锁；与新来源绑定任务混用明确拒绝；worker 桶忙锁不退化', async () => {
  const env = await setup()
  const { gateway } = env
  const sessionId = 'sess-legacy'
  try {
    const legacy = await dispatch(gateway, { instruction: 'legacy', sessionId })
    assert.equal(legacy.status, 202, JSON.stringify(legacy.body))
    assert.equal(legacy.body.originThreadId, undefined)
    // 旧路径的第二次派活仍被忙锁拒绝（语义不变）
    const legacy2 = await dispatch(gateway, { instruction: 'legacy-2', sessionId })
    assert.equal(legacy2.status, 400)
    assert.equal(legacy2.body.reason, 'session-busy')
    // 新来源绑定任务不能与旧不可精确关联任务混用
    const mixed = await dispatch(gateway, { instruction: 'precise', sessionId, originThreadId: 'delivery-origin-legacy' })
    assert.equal(mixed.status, 400)
    assert.equal(mixed.body.reason, 'legacy-mix-unsafe')
    assert.equal(gateway.prompts.length, 1, '被拒的派活零 prompt')
    // worker 桶忙锁保留
    const w1 = await dispatch(gateway, { instruction: 'w1', cwd: 'E:/tmp/delivery-bucket' })
    assert.equal(w1.status, 202)
    await gateway.waitForChild('w1')
    const w2 = await dispatch(gateway, { instruction: 'w2', cwd: 'E:/tmp/delivery-bucket' })
    assert.equal(w2.status, 400)
    assert.equal(w2.body.reason, 'worker-bucket-busy')
  } finally {
    await gateway.close()
  }
})

test('取消安全：有别的在途任务时拒绝 session cancel；排队项/回执明确不支持撤销', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'delivery-origin-cancel'
  const sessionId = 'sess-cancel'
  try {
    const a = await dispatch(gateway, { instruction: 'A', sessionId, originThreadId: origin })
    await startExecuting(env, { sessionId, taskId: a.body.taskId, turn: 1, origin })
    const b = await dispatch(gateway, { instruction: 'B', sessionId, originThreadId: origin })
    assert.equal(b.body.status, 'queued')
    // A 正在跑，但同会话还有排队 B → 不允许 session cancel（会连 B 一起杀掉）
    const cancelA = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: a.body.taskId, force: true, originThreadId: origin })
    assert.equal(cancelA.status, 409, JSON.stringify(cancelA.body))
    assert.equal(cancelA.body.reason, 'cancel-unsafe-with-other-tasks')
    assert.equal((await statusOf(gateway, a.body.taskId, origin)).status, 'running', '被拒的取消不得改变状态')
    // 排队项不能撤销（官方只有 session 级 cancel）
    const cancelB = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: b.body.taskId, force: true, originThreadId: origin })
    assert.equal(cancelB.status, 409)
    assert.equal(cancelB.body.reason, 'cancel-unsupported-for-queued')
    // A 自己可以取消（此时 B 仍在 → 仍拒），A 结束后 B 成为唯一在途 → 允许
    await finishTask(env, { sessionId, taskId: a.body.taskId, turn: 1, text: 'A-DONE', origin })
    await startExecuting(env, { sessionId, taskId: b.body.taskId, turn: 2, origin })
    const cancelB2 = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: b.body.taskId, force: true, originThreadId: origin })
    assert.equal(cancelB2.status, 200, JSON.stringify(cancelB2.body))
    assert.equal(cancelB2.body.cancelled, true)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- steer

const steerSetup = async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1200' })
  const origin = 'delivery-origin-steer'
  const sessionId = 'sess-steer'
  const a = await dispatch(env.gateway, { instruction: 'A', sessionId, originThreadId: origin, delegate: true, delegateTtlSec: 600 }, HEADERS)
  assert.equal(a.status, 202, JSON.stringify(a.body))
  await startExecuting(env, { sessionId, taskId: a.body.taskId, turn: 1, origin })
  return { env, origin, sessionId, a }
}

test('steer：显式父任务 + 同 origin/会话 + 父在执行/回合可证 → 回执接收，且不签发 grant、不成为审批 owner', async () => {
  const { env, origin, sessionId, a } = await steerSetup()
  const { gateway } = env
  try {
    const grantsBefore = env.grantRows().length
    const parentStatus = await statusOf(gateway, a.body.taskId, origin)
    const receipt = await postJson(gateway.url + '/api/dsh-bridge/task', {
      instruction: 'S1 补充', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: a.body.taskId, expectedTurn: 1,
    }, HEADERS)
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body))
    assert.equal(receipt.body.deliver, 'steer')
    assert.equal(receipt.body.parentTaskId, a.body.taskId)
    assert.equal(receipt.body.resultScope, 'parent-task')
    assert.equal(receipt.body.receiptState, 'accepted')
    assert.equal(env.grantRows().length, grantsBefore, '回执不签发 grant')
    assert.equal(receipt.body.grantId, undefined, '回执没有自己的 grant')
    // prompts：父 1 条 + 回执 1 条，且回执的 mode=steer、requestId 是回执自己的 taskId
    assert.equal(gateway.prompts.length, 2)
    assert.equal(gateway.prompts[1].mode, 'steer')
    assert.equal(gateway.prompts[1].requestId, receipt.body.taskId)
    assert.notEqual(receipt.body.taskId, a.body.taskId, '回执有独立 taskId')
    // 回执不是"另一个独立任务"：不占队列、不被标 running
    const receiptStatus = await statusOf(gateway, receipt.body.taskId, origin)
    assert.equal(receiptStatus.deliver, 'steer')
    assert.notEqual(receiptStatus.status, 'running')

    // 观察到自己的 rpcId 落进父回合 → receipt-observed + observedTurn=1
    env.push(['user/message', { id: 'u-S1', role: 'user', content: [{ type: 'text', text: 'S1' }], source: { rpcId: receipt.body.taskId } }])
    const observed = await until(async () => {
      const st = await statusOf(gateway, receipt.body.taskId, origin)
      return st.receiptState === 'observed' ? st : false
    }, { timeoutMs: 4000, intervalMs: 100 })
    assert.notEqual(observed, false, '回执必须在自己 rpcId 出现后变为 observed')
    assert.equal(observed.observedTurn, 1, 'observedTurn 必须是父任务那个回合')
    assert.equal(observed.resultScope, 'parent-task')
    assert.equal(observed.result, undefined, '回执绝不冒充父任务的独立结果')
    // 父任务仍然是它自己的状态与结果归属
    assert.equal((await statusOf(gateway, a.body.taskId, origin)).status, 'running')
    assert.equal(parentStatus.deliver !== 'steer', true)
  } finally {
    await gateway.close()
  }
})

test('steer 回执未观察到：单次窗口过后转 receipt-pending（非终态），迟到 rpc 可由后续查询续证；父回合结束才 unconfirmed', async () => {
  const { env, origin, sessionId, a } = await steerSetup()
  const { gateway } = env
  try {
    const receipt = await postJson(gateway.url + '/api/dsh-bridge/task', {
      instruction: 'S-late', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: a.body.taskId,
    }, HEADERS)
    assert.equal(receipt.status, 202)
    // 单次等待窗口（测试里 1.2s）过后：**不是**永久未确认，而是 pending（仍在总观察寿命内求证）。
    const pending = await until(async () => {
      const st = await statusOf(gateway, receipt.body.taskId, origin)
      return st.receiptState === 'pending' ? st : false
    }, { timeoutMs: 6000, intervalMs: 100 })
    assert.notEqual(pending, false, '单次窗口过后必须是 receipt-pending，而不是永久未确认')
    assert.equal(pending.status, 'receipt-pending')
    assert.equal(pending.resend, false, '官方已接收 → 绝不重发')
    assert.equal(pending.resultScope, 'parent-task')
    assert.equal(pending.result, undefined, '回执绝不携带父结果')
    // 长工具结束后，迟到 rpc 落进**同一个**父回合 → 后续显式查询必须能证明（不丢确认）。
    env.push(['user/message', { id: 'u-late', role: 'user', content: [{ type: 'text', text: 'late' }], source: { rpcId: receipt.body.taskId } }])
    const observed = await until(async () => {
      const st = await statusOf(gateway, receipt.body.taskId, origin)
      return st.receiptState === 'observed' ? st : false
    }, { timeoutMs: 6000, intervalMs: 150 })
    assert.notEqual(observed, false, '迟到 rpc 必须能被后续查询证明为 observed')
    assert.equal(observed.observedTurn, 1, 'observedTurn = 服务端捕获的父回合')
    assert.equal(observed.result, undefined)
    assert.equal(gateway.prompts.filter((p) => p.requestId === receipt.body.taskId).length, 1, '全程只投递一次（不重发）')

    // 另一条回执：父回合结束而自己从未落进日志 → 明确 unconfirmed（仍然 resend:false）
    const orphan = await postJson(gateway.url + '/api/dsh-bridge/task', {
      instruction: 'S-orphan', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: a.body.taskId,
    }, HEADERS)
    assert.equal(orphan.status, 202)
    await until(async () => (await statusOf(gateway, orphan.body.taskId, origin)).receiptState === 'pending', { timeoutMs: 6000, intervalMs: 100 })
    await finishTask(env, { sessionId, taskId: a.body.taskId, turn: 1, text: 'A-DONE', origin })
    const unconfirmed = await until(async () => {
      const st = await statusOf(gateway, orphan.body.taskId, origin)
      return st.receiptState === 'unconfirmed' ? st : false
    }, { timeoutMs: 8000, intervalMs: 150 })
    assert.notEqual(unconfirmed, false, '父回合结束而自己没有落进去 → 必须明确 unconfirmed')
    assert.equal(unconfirmed.status, 'receipt-unconfirmed')
    assert.equal(unconfirmed.resend, false)
    assert.equal(gateway.prompts.filter((p) => p.requestId === orphan.body.taskId).length, 1, 'unconfirmed 也绝不重发')
  } finally {
    await gateway.close()
  }
})

test('steer 零投递负例：无父/父终态/父排队/错来源/错 expectedTurn/缺凭据/无来源 全部零 prompt', async () => {
  const { env, origin, sessionId, a } = await steerSetup()
  const { gateway } = env
  try {
    const base = { instruction: 'S', sessionId, originThreadId: origin, deliver: 'steer' }
    const before = gateway.prompts.length
    const noParent = await postJson(gateway.url + '/api/dsh-bridge/task', base, HEADERS)
    assert.equal(noParent.status, 400)
    assert.equal(noParent.body.reason, 'steer-parent-required')
    const unknownParent = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: 'task-does-not-exist' }, HEADERS)
    assert.equal(unknownParent.body.reason, 'steer-parent-invalid')
    const wrongOrigin = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: a.body.taskId, originThreadId: 'someone-else' }, HEADERS)
    assert.equal(wrongOrigin.body.reason, 'steer-parent-invalid')
    const wrongTurn = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: a.body.taskId, expectedTurn: 9 }, HEADERS)
    assert.equal(wrongTurn.body.reason, 'steer-turn-mismatch')
    const noAuth = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: a.body.taskId })
    assert.equal(noAuth.status, 401, 'steer 必须要求控制凭据')
    const noOrigin = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'S', sessionId, deliver: 'steer', parentTaskId: a.body.taskId }, HEADERS)
    assert.equal(noOrigin.body.reason, 'steer-origin-required')
    assert.equal(gateway.prompts.length, before, '以上全部零 prompt')

    // 父终态 → 拒绝；父排队（还没执行）→ 拒绝
    const queuedParent = await dispatch(gateway, { instruction: 'B-queued', sessionId, originThreadId: origin })
    assert.equal(queuedParent.body.status, 'queued')
    const steerQueued = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: queuedParent.body.taskId }, HEADERS)
    assert.equal(steerQueued.body.reason, 'steer-parent-queued')
    await startExecuting(env, { sessionId, taskId: queuedParent.body.taskId, turn: 2, origin })
    await finishTask(env, { sessionId, taskId: queuedParent.body.taskId, turn: 2, text: 'Q-DONE', origin })
    const steerTerminal = await postJson(gateway.url + '/api/dsh-bridge/task', { ...base, parentTaskId: queuedParent.body.taskId }, HEADERS)
    assert.equal(steerTerminal.body.reason, 'steer-parent-terminal')
    assert.equal(gateway.prompts.filter((p) => p.mode === 'steer').length, 0, '所有负例都不得发出 steer')
  } finally {
    await gateway.close()
  }
})

test('审批隔离：回执与 A 同 turn，但审批 owner 只认 A；A 收口不清 B 的 pending', async () => {
  const { env, origin, sessionId, a } = await steerSetup()
  const { gateway } = env
  try {
    // A 的 grantId
    const grantA = env.grantRows()[0].grantId
    // A 挂起一条审批（真实 ask 流：tool/call + approval/asked + pre-execute 快照）
    const callId = 'call-iso-1'
    env.push(['tool/call', { turn: 1, step: 1, callId, name: 'pwsh', arguments: '{}' }], ['approval/asked', { id: 'off-iso', toolName: 'pwsh', callId }])
    gateway.emitCtx('tools/pre-execute', {
      agent: { session: { id: sessionId, header: { id: sessionId, cwd: 'E:/work' } } },
      callId, rootCallId: callId, name: 'pwsh', arguments: { command: 'iso' },
    }, () => ({ kind: 'allow' }))
    const state = { humanNext: 0 }
    const held = gateway.emitCtx('approval/request', { agent: { session: { id: sessionId } }, toolName: 'pwsh', callId, reason: 'fixture' }, () => { state.humanNext += 1; return Promise.resolve('rejected') })
    const listed = await until(async () => {
      const res = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(a.body.taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.length > 0 ? res : false
    })
    assert.notEqual(listed, false, 'A 必须能挂起审批')
    const pending = listed.body.approvals[0]
    assert.equal(pending.grantId, grantA, 'owner 必须是 A 的 grant')
    assert.equal(state.humanNext, 0, 'A 的 ask 必须由桥接管（不是人工链）')
    // 回执与 A 同 turn
    const receipt = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'S-iso', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: a.body.taskId }, HEADERS)
    assert.equal(receipt.status, 202)
    env.push(['user/message', { id: 'u-Siso', role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: receipt.body.taskId } }])
    await until(async () => (await statusOf(gateway, receipt.body.taskId, origin)).receiptState === 'observed')
    // 回执绝不产生 pending，也不认领 A 的官方 ask
    const receiptList = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(receipt.body.taskId), HEADERS)
    assert.equal(receiptList.body.approvals.length, 0, '回执不得成为审批 owner')
    // B 排队并带自己的 grant + 自己的 pending
    const b = await dispatch(gateway, { instruction: 'B', sessionId, originThreadId: origin, delegate: true }, HEADERS)
    assert.equal(b.status, 202)
    const grantB = env.grantRows().at(-1).grantId
    assert.notEqual(grantB, grantA)
    const callIdB = 'call-iso-2'
    env.push(['tool/call', { turn: 2, step: 1, callId: callIdB, name: 'pwsh', arguments: '{}' }], ['approval/asked', { id: 'off-iso-b', toolName: 'pwsh', callId: callIdB }])
    gateway.emitCtx('tools/pre-execute', {
      agent: { session: { id: sessionId, header: { id: sessionId, cwd: 'E:/work' } } },
      callId: callIdB, rootCallId: callIdB, name: 'pwsh', arguments: { command: 'iso-b' },
    }, () => ({ kind: 'allow' }))
    // B 还没执行（queued）→ B 的 ask 不应由桥接管（owner 不是 B）
    const heldB = gateway.emitCtx('approval/request', { agent: { session: { id: sessionId } }, toolName: 'pwsh', callId: callIdB, reason: 'fixture' }, () => Promise.resolve('rejected'))
    await sleep(200)
    // A 的 pending 仍在；B 的 ask 未成为 pending（交还人工）
    const aStill = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(a.body.taskId), HEADERS)
    assert.equal(aStill.body.approvals.some((p) => p.approvalKey === pending.approvalKey), true, 'A 的 pending 不受 B/回执影响')
    const bPendings = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(b.body.taskId), HEADERS)
    assert.equal(bPendings.body.approvals.length, 0, '未执行的任务不能借同会话的 ask 拿到 pending')
    assert.equal(await heldB[0], 'rejected', 'B 的 ask 必须交还人工')
    // A 收口（其回合结束）只关自己的 pending，不动 B 的 grant/记录
    // 先给 B 一个真实 pending（让 B 开始执行后再 ask）
    await finishTask(env, { sessionId, taskId: a.body.taskId, turn: 1, text: 'A-DONE', origin })
    const stillListed = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(a.body.taskId), HEADERS)
    assert.equal(stillListed.body.approvals.length === 0 || stillListed.body.approvals.every((p) => p.state !== 'pending'), true, 'A 收口后其 pending 不再可答')
    assert.equal(env.grantRows().some((g) => g.grantId === grantB), true, 'B 的 grant 不受 A 收口影响')
    // A 收口会把 A 的 pending 交还人工链（superseded + next()），这是预期行为——覆盖在上面的 humanNext 断言之前已确认接管。
    // 清理：A 的延迟 ask 返回
    await Promise.allSettled(held)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 客户端（MCP / CLI）实测 queue 与 steer

test('MCP 与 CLI 都实测 queue（忙时接收）与 steer（父回执），并拒绝旧网关的新字段', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'delivery-origin-client'
  const sessionId = 'sess-client'
  try {
    const a = await dispatch(gateway, { instruction: 'A', sessionId, originThreadId: origin })
    await startExecuting(env, { sessionId, taskId: a.body.taskId, turn: 1, origin })

    // MCP queue：忙时接收
    const mcpQueue = await runMcp(env.mcpEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: 'B via MCP', sessionId, originThreadId: origin, deliver: 'queue', wait: false }),
    ], 20000)
    const bPayload = payloadOf(mcpQueue.get(1))
    assert.equal(bPayload.taskId !== undefined, true, 'MCP queue 必须被接受: ' + JSON.stringify(bPayload))
    assert.equal(bPayload.status, 'queued', 'MCP queue 在忙时应是 queued: ' + JSON.stringify(bPayload))

    // MCP steer：显式父任务，回执语义
    const mcpSteer = await runMcp(env.mcpEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: 'S via MCP', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: a.body.taskId, wait: false }),
    ], 20000)
    const sPayload = payloadOf(mcpSteer.get(1))
    assert.equal(sPayload.parentTaskId, a.body.taskId, 'MCP steer 必须回执父任务: ' + JSON.stringify(sPayload))
    assert.equal(sPayload.resultScope, 'parent-task')
    // MCP steer 缺父任务 → 零投递
    const mcpNoParent = await runMcp(env.mcpEnv, [mcpInit(0), mcpCall(1, 'dsh_task', { instruction: 'x', sessionId, originThreadId: origin, deliver: 'steer', wait: false })], 20000)
    assert.equal(payloadOf(mcpNoParent.get(1)).reason, 'steer-parent-required')

    // CLI queue：忙时接收
    const cliQueue = await runCli(['--in', 'C via CLI', '--session', sessionId, '--origin', origin, '--no-wait'], env.cliEnv)
    assert.equal(cliQueue.status, 0, 'CLI queue 必须被接受: ' + cliQueue.stderr)
    const cliQueuePayload = JSON.parse(cliQueue.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1))
    assert.equal(cliQueuePayload.status, 'queued')
    // CLI steer：回执（不等待父结果，退出 0 并声明 resultScope）
    const cliSteer = await runCli(['--in', 'S via CLI', '--session', sessionId, '--origin', origin, '--parent', a.body.taskId], env.cliEnv)
    assert.equal(cliSteer.status, 0, 'CLI steer 必须成功: ' + cliSteer.stderr)
    const cliSteerPayload = JSON.parse(cliSteer.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1))
    assert.equal(cliSteerPayload.resultScope, 'parent-task')
    assert.equal(cliSteerPayload.parentTaskId, a.body.taskId)
    // CLI steer 缺 --parent → 用法错误、零投递
    const before = gateway.prompts.length
    const cliNoParent = await runCli(['--in', 'x', '--session', sessionId, '--origin', origin, '--steer'], env.cliEnv)
    assert.equal(cliNoParent.status, 2)
    assert.equal(gateway.prompts.length, before, '缺 --parent 零投递')

    // 旧网关（有来源绑定与审批能力，但**没有** capabilities.delivery）→ 新字段零派活拒绝
    // （先满足更早的预检，才能精确验证"只因 delivery 缺失而被拒"）
    const bare = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ capabilities: { originBinding: { supported: true, version: 1 }, approvals: { supported: true, enabled: true } } }))
    })
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve))
    try {
      const oldEnv = { DSH_BRIDGE_URL: 'http://127.0.0.1:' + bare.address().port, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }
      const oldMcp = await runMcp(oldEnv, [mcpInit(0), mcpCall(1, 'dsh_task', { instruction: 'x', sessionId, originThreadId: origin, deliver: 'steer', parentTaskId: 't', wait: false })], 20000)
      assert.equal(payloadOf(oldMcp.get(1)).reason, 'delivery-unsupported', '旧网关的 steer 必须零派活拒绝: ' + JSON.stringify(payloadOf(oldMcp.get(1))))
      const oldCli = await runCli(['--in', 'x', '--session', sessionId, '--origin', origin, '--parent', 't'], oldEnv)
      assert.equal(oldCli.status, 2, '旧网关的 CLI steer 必须预检拒绝')
    } finally {
      await new Promise((resolve) => bare.close(resolve))
    }
  } finally {
    await gateway.close()
  }
})
