/**
 * 会话目标的**精确请求回合关联**回归（真实 SDK 字段形状）。
 *
 * 依据本机 controller 0.2.0-rc.2 实测：
 *   - `prompt.requestId` → `user/message.data.source.rpcId`（唯一可靠凭据；`user/message.data.turn` 不存在）
 *   - turn 号靠按 seq 有序跟踪"未闭合的 turn/start"
 *   - `assistant/message.data = {turn, step, message:{content}}`；`turn/end.data = {turn, reason:{kind}}`
 *   - follow 开场是 `{type:'snapshot', records:[{type:'event',event}]}`（不是 snapshot.events）
 *   - `api-session/status` 只表示 agent 是否 running，**不是**某请求完成的证明
 *
 * 全部走真实 HTTP 请求；会话日志/follow 帧由隔离宿主注入，不碰真实 DSH。
 * 跑法: node test/codex-session-correlation.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { openAssociations } from '../harness/codex-associations.mjs'
import {
  disposeAll,
  makeTmp,
  startGateway,
  tick,
} from './helpers/dsh-host.mjs'

after(async () => { await disposeAll() })

/** HTTP 辅助：保留原始 body 文本，失败时能直接看到 500/空 body 的真实内容。 */
const postJson = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { /* non-JSON */ }
  return { status: res.status, body: parsed, text }
}
const getJson = async (url) => {
  const res = await fetch(url)
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { /* non-JSON */ }
  return { status: res.status, body: parsed, text }
}

/** 派发必须真的成功（202 + taskId）；否则把状态/原始 body/路由错误一起报出来。 */
const dispatchDiag = (res, gateway) => JSON.stringify({ status: res.status, text: res.text, prompts: gateway.prompts.length, starts: gateway.starts.length, routeErrors: gateway.routeErrors })
const expectDispatched = (res, gateway, label) => {
  if (res.status !== 202 || res.body === null || typeof res.body.taskId !== 'string' || res.body.taskId === '') {
    assert.fail(label + ' 必须派发成功: ' + dispatchDiag(res, gateway))
  }
  return res
}

/**
 * **有上限的条件等待**：轮询直到状态满足断言条件（不是固定长 sleep）。
 * 收尾是异步的（live follow / 读日志 / sweep），负载高时固定等待会假阴性。
 */
const waitForStatus = async (url, predicate, waitOptions = {}) => {
  const timeoutMs = typeof waitOptions.timeoutMs === 'number' ? waitOptions.timeoutMs : 5000
  const intervalMs = typeof waitOptions.intervalMs === 'number' ? waitOptions.intervalMs : 25
  const deadline = Date.now() + timeoutMs
  let last = await getJson(url)
  for (;;) {
    if (predicate(last.body)) return last
    if (Date.now() > deadline) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await getJson(url)
  }
}

/** 一条会话事件（SDK 形状：{seq, type, data}）。 */
const ev = (seq, type, data) => ({ seq, type, data })
const statusUrl = (base, taskId, origin) => base + '/api/dsh-bridge/status?taskId=' + taskId + '&originThreadId=' + origin

test('精确关联：排队请求忽略先前回合；自己的 turn/end(completed) 才完成且只含自己的文字，且不需要新的 running=true', async () => {
  const assocRoot = await makeTmp('dsh-sess-a-')
  const events = []
  const gateway = await startGateway({ assocRoot, events })
  const url = gateway.url + '/api/dsh-bridge/task'
  try {
    const submitted = await postJson(url, { instruction: 'this-request', sessionId: 'sess-a', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(submitted, gateway, '派发(submitted)')
    assert.equal(submitted.status, 202)
    const taskId = submitted.body.taskId
    assert.equal(gateway.prompts[0].requestId, taskId, 'prompt 必须带 requestId=taskId')

    // 一个**先前**的回合在我们的请求入队之后才结束
    events.push(
      ev(1, 'turn/start', { turn: 7 }),
      ev(2, 'user/message', { id: 'prior-user', role: 'user', content: [{ type: 'text', text: 'prior request' }], source: { rpcId: 'prior-request' } }),
      ev(3, 'assistant/message', { turn: 7, step: 1, message: { id: 'prior-assistant', role: 'assistant', content: [{ type: 'text', text: 'WRONG PRIOR RESULT' }] } }),
      ev(4, 'turn/end', { turn: 7, reason: { kind: 'completed' } }),
    )
    gateway.emitCtx('api-session/status', 'sess-a', true)
    gateway.emitCtx('api-session/status', 'sess-a', false)
    // 负向断言（"不能变成 done"）：给异步观察一点时间后仍必须是未完成
    await tick(120)

    const beforeOwn = await getJson(statusUrl(gateway.url, taskId, 'source-A'))
    assert.notEqual(beforeOwn.body.status, 'done', '别的请求跑完不能收尾我们的排队任务')
    assert.equal(beforeOwn.body.result, undefined, '先前回合的文字绝不能成为我们的结果')

    // 自己的回合：注意**没有**再发 running=true
    events.push(
      ev(5, 'turn/start', { turn: 8 }),
      ev(6, 'user/message', { id: 'own-user', role: 'user', content: [{ type: 'text', text: 'this-request' }], source: { rpcId: taskId } }),
      ev(7, 'assistant/message', { turn: 8, step: 1, message: { id: 'own-assistant', role: 'assistant', content: [{ type: 'text', text: 'CORRECT OWN RESULT' }] } }),
      ev(8, 'turn/end', { turn: 8, reason: { kind: 'completed' } }),
    )
    gateway.emitCtx('api-session/status', 'sess-a', false)
    // 正向断言：有上限地等它真的完成（收尾是异步的，负载高时固定 sleep 会假阴性）
    const done = await waitForStatus(statusUrl(gateway.url, taskId, 'source-A'), (body) => body !== null && body.status === 'done')
    assert.equal(done.body.status, 'done')
    assert.equal(done.body.result, 'CORRECT OWN RESULT')
    assert.equal(done.body.requestId, taskId, 'status 应回显 requestId')
    assert.equal(done.body.dshTurn, 8, 'status 应回显匹配到的 DSH turn')

    // 真实回读磁盘（不是占位断言）：关联记录必须持久保存来源/任务/请求/turn/结果
    const record = openAssociations({ root: assocRoot }).record(taskId)
    assert.equal(record.originThreadId, 'source-A')
    assert.equal(record.taskId, taskId)
    assert.equal(record.requestId, taskId, 'requestId 必须落盘')
    assert.equal(record.dshTurn, 8, '匹配到的 DSH turn 必须落盘')
    assert.equal(record.status, 'done')
    assert.equal(record.result, 'CORRECT OWN RESULT')
    assert.equal(record.delivered, true)

    // 新实例共享同一 assocRoot（旧实例先关）：按 origin+taskId 恢复同样的结果与归属，且零派活
    await gateway.close()
    const second = await startGateway({ assocRoot })
    try {
      const recovered = await getJson(statusUrl(second.url, taskId, 'source-A'))
      assert.equal(recovered.status, 200)
      assert.equal(recovered.body.status, 'done')
      assert.equal(recovered.body.result, 'CORRECT OWN RESULT')
      assert.equal(recovered.body.requestId, taskId, '恢复路径必须回显 requestId')
      assert.equal(recovered.body.dshTurn, 8, '恢复路径必须回显 dshTurn')
      assert.equal(recovered.body.recovered, true)
      assert.equal(second.prompts.length, 0, '恢复路径绝不发 prompt')
      assert.equal(second.starts.length, 0)
    } finally {
      await second.close()
    }
  } finally {
    await gateway.close()
  }
})

test('精确关联：匹配回合以 error/blocked 结束时是明确失败，绝不因为"有文字"就 done', async () => {
  const assocRoot = await makeTmp('dsh-sess-b-')
  for (const kind of ['error', 'blocked', 'aborted', 'max-tokens']) {
    const events = []
    const gateway = await startGateway({ assocRoot, events })
    try {
      const submitted = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'will-' + kind, sessionId: 'sess-' + kind, deliver: 'queue', originThreadId: 'source-A' })
      expectDispatched(submitted, gateway, '派发(submitted)')
      const taskId = submitted.body.taskId
      gateway.emitCtx('api-session/status', 'sess-' + kind, true)
      events.push(
        ev(1, 'turn/start', { turn: 1 }),
        ev(2, 'user/message', { id: 'u', role: 'user', source: { rpcId: taskId } }),
        ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'partial answer' }] } }),
        ev(4, 'turn/end', { turn: 1, reason: { kind } }),
      )
      gateway.emitCtx('api-session/status', 'sess-' + kind, false)
      // 有上限地等它真的落成终态失败（而不是固定 sleep）
      const result = await waitForStatus(statusUrl(gateway.url, taskId, 'source-A'), (body) => body !== null && body.status === 'error')
      assert.equal(result.body.status, 'error', 'kind=' + kind + ' 必须是终态失败')
      assert.equal(result.body.result, undefined, 'kind=' + kind + ' 不得把部分文字当结果')
      assert.equal(result.body.turnEndKind, kind)
      assert.equal(result.body.partialResult, 'partial answer', '失败的回合保留部分文字（仅内存可见）')

      // 磁盘状态同样要核对：失败必须真的落盘成 error，并保留 error/reason 与请求归属
      const record = openAssociations({ root: assocRoot }).record(taskId)
      assert.equal(record.status, 'error', 'kind=' + kind + ' 磁盘状态必须也是 error')
      assert.equal(record.reason, 'session-turn-failed')
      assert.match(record.error, new RegExp(kind), '落盘的 error 文案要写明结束 kind')
      assert.equal(record.originThreadId, 'source-A')
      assert.equal(record.requestId, taskId, '失败任务同样要落盘 requestId')
      assert.equal(record.dshTurn, 1, '失败任务同样要落盘匹配到的 turn')
      assert.equal(record.result, undefined, '失败不得把部分文字写成 result')
    } finally {
      await gateway.close()
    }
  }
})

test('精确关联：follow 开场 snapshot.records 里的已完成请求必须被收（不能整块丢弃）', async () => {
  const assocRoot = await makeTmp('dsh-sess-c-')
  let taskId
  const gateway = await startGateway({
    assocRoot,
    follow: async function* () {
      await tick(50)
      yield {
        type: 'snapshot',
        header: { version: 1, id: 'sess-snapshot', createdAt: 1, isSeeded: false },
        cursor: 4,
        hasMore: false,
        projections: { asOfSeq: 4, values: {} },
        records: [
          ev(1, 'turn/start', { turn: 1 }),
          ev(2, 'user/message', { id: 'snapshot-user', role: 'user', source: { rpcId: taskId } }),
          ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SNAPSHOT RESULT' }] } }),
          ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
        ].map((event) => ({ type: 'event', event })),
      }
    },
  })
  try {
    const submitted = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'snapshot-request', sessionId: 'sess-snapshot', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(submitted, gateway, '派发(submitted)')
    taskId = submitted.body.taskId
    const result = await waitForStatus(statusUrl(gateway.url, taskId, 'source-A'), (body) => body !== null && body.status === 'done')
    assert.equal(result.body.status, 'done', '快照里可能已经包含快速完成的请求，必须检查 records')
    assert.equal(result.body.result, 'SNAPSHOT RESULT')
  } finally {
    await gateway.close()
  }
})

test('精确关联：同一条事件被 snapshot 与日志重复投递时不串文本、不重复计字', async () => {
  const assocRoot = await makeTmp('dsh-sess-d-')
  const events = [
    ev(1, 'turn/start', { turn: 3 }),
    ev(2, 'user/message', { id: 'dup-user', role: 'user', source: { rpcId: 'PLACEHOLDER' } }),
    ev(3, 'assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: 'ONLY-ONCE' }] } }),
    ev(4, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
  let taskId
  const gateway = await startGateway({
    assocRoot,
    events,
    follow: async function* () {
      await tick(40)
      // 先投一遍 snapshot（含整轮），之后读日志还会再看到同样 seq 的事件
      yield {
        type: 'snapshot',
        cursor: 4,
        hasMore: false,
        records: events.map((event) => ({ type: 'event', event: { ...event, data: event.type === 'user/message' ? { ...event.data, source: { rpcId: taskId } } : event.data } })),
      }
      await tick(60)
    },
  })
  try {
    const submitted = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'dup', sessionId: 'sess-dup', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(submitted, gateway, '派发(submitted)')
    taskId = submitted.body.taskId
    events[1].data.source.rpcId = taskId
    const result = await waitForStatus(statusUrl(gateway.url, taskId, 'source-A'), (body) => body !== null && body.status === 'done')
    assert.equal(result.body.status, 'done')
    assert.equal(result.body.result, 'ONLY-ONCE', '重复投递不得把文本算两遍')
  } finally {
    await gateway.close()
  }
})

test('精确关联：没有匹配 rpcId 就没有完成证据 → 未确认（resend:false），不借旧回合假成功', async () => {
  const assocRoot = await makeTmp('dsh-sess-e-')
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { id: 'someone-else', role: 'user', source: { rpcId: 'other-request' } }),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'OTHER RESULT' }] } }),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const gateway = await startGateway({
    assocRoot,
    events,
    // quiet/budget 收紧，让"无证据"路径在测试里可达
    env: { DSH_BRIDGE_SESSION_QUIET_TIMEOUT_MS: 250, DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS: 900, DSH_BRIDGE_SESSION_DISPATCH_TIMEOUT_MS: 500 },
  })
  try {
    const submitted = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'no-match', sessionId: 'sess-nomatch', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(submitted, gateway, '派发(submitted)')
    const taskId = submitted.body.taskId
    gateway.emitCtx('api-session/status', 'sess-nomatch', true)
    gateway.emitCtx('api-session/status', 'sess-nomatch', false)
    // 负向断言：给异步观察一点时间后仍不能变成 done
    await tick(400)
    const observed = await getJson(statusUrl(gateway.url, taskId, 'source-A'))
    assert.notEqual(observed.body.status, 'done', '别人的回合结束不是我们的证据')
    assert.equal(observed.body.result, undefined)

    // 等预算过期：必须明确"未确认 + 不要重发"，而不是 done。
    // 预算转换由 timer 的 sweep 驱动，所以用**有界循环**交替"触发一次 sweep + 轮询状态"，不用固定 sleep。
    let unconfirmed = await getJson(statusUrl(gateway.url, taskId, 'source-A'))
    const deadline = Date.now() + 8000
    while (unconfirmed.body.status !== 'unknown' && Date.now() < deadline) {
      await gateway.runIntervals(80)
      unconfirmed = await getJson(statusUrl(gateway.url, taskId, 'source-A'))
    }
    assert.equal(unconfirmed.body.status, 'unknown', '没有匹配回合证据只能报未确认: ' + JSON.stringify(unconfirmed.body))
    assert.equal(unconfirmed.body.resend, false)
    assert.equal(unconfirmed.body.delivered, true, '已知 delivered 必须保留')
    assert.match(unconfirmed.body.note, /unconfirmed/)
  } finally {
    await gateway.close()
  }
})

test('精确关联：带来源的会话派发拒绝 steer（执行前拒绝、零 prompt）；无来源的旧路径仍允许', async () => {
  const assocRoot = await makeTmp('dsh-sess-f-')
  const gateway = await startGateway({ assocRoot, env: { DSH_BRIDGE_SESSION_DISPATCH_TIMEOUT_MS: 300 } })
  const url = gateway.url + '/api/dsh-bridge/task'
  try {
    const steer = await postJson(url, { instruction: 'steer-with-origin', sessionId: 'sess-steer', deliver: 'steer', originThreadId: 'source-A' })
    // 这一路期望的是**被拒绝**（不是派发成功）
    assert.notEqual(steer.status, 202, '带来源的 steer 必须被拒绝: ' + dispatchDiag(steer, gateway))
    assert.equal(steer.body.reason, 'origin-steer-unsupported')
    assert.equal(gateway.prompts.length, 0, '拒绝必须发生在 prompt 之前')

    // 旧的无来源 steer 行为保留
    const legacy = await postJson(url, { instruction: 'legacy steer', sessionId: 'sess-steer-legacy', deliver: 'steer' })
    expectDispatched(legacy, gateway, '派发(legacy)')
    assert.equal(legacy.status, 202)
    assert.equal(gateway.prompts.length, 1)
    assert.equal(gateway.prompts[0].mode, 'steer')
  } finally {
    await gateway.close()
  }
})

test('精确关联：快照缺前半段（没有 turn/start）不阻断——完整日志回填后仍能收尾', async () => {
  const assocRoot = await makeTmp('dsh-sess-h-')
  let taskId
  const events = []
  const gateway = await startGateway({
    assocRoot,
    events,
    follow: async function* () {
      await tick(50)
      events.push(
        ev(1, 'turn/start', { turn: 8 }),
        ev(2, 'user/message', { id: 'partial-user', role: 'user', source: { rpcId: taskId } }),
        ev(3, 'assistant/message', { turn: 8, step: 1, message: { content: [{ type: 'text', text: 'BACKFILLED RESULT' }] } }),
        ev(4, 'turn/end', { turn: 8, reason: { kind: 'completed' } }),
      )
      // 快照故意**缺** turn/start：live 这条路上当时无法关联，但事件不能因此被永久丢弃
      yield { type: 'snapshot', cursor: 4, hasMore: true, records: events.slice(1).map((event) => ({ type: 'event', event })) }
    },
  })
  try {
    const submitted = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'partial-snapshot-request', sessionId: 'sess-partial', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(submitted, gateway, '派发(submitted)')
    taskId = submitted.body.taskId
    gateway.emitCtx('api-session/status', 'sess-partial', true)
    await tick(100)
    gateway.emitCtx('api-session/status', 'sess-partial', false)
    const result = await waitForStatus(statusUrl(gateway.url, taskId, 'source-A'), (body) => body !== null && body.status === 'done')
    assert.equal(result.body.status, 'done', '去重过的"当时无法关联"的事件在完整日志里必须能重新消费')
    assert.equal(result.body.result, 'BACKFILLED RESULT')
  } finally {
    await gateway.close()
  }
})

test('精确关联：worker 任务不受影响；会话任务的 cancel 仍会持久写回终态', async () => {
  const assocRoot = await makeTmp('dsh-sess-g-')
  const gateway = await startGateway({ assocRoot })
  const url = gateway.url + '/api/dsh-bridge/task'
  try {
    const worker = await postJson(url, { instruction: 'worker 正常', cwd: 'E:/fixture/sess-worker', originThreadId: 'source-A' })
    expectDispatched(worker, gateway, '派发(worker)')
    assert.equal(worker.status, 202)
    assert.equal(gateway.starts.length, 1)

    const session = await postJson(url, { instruction: '会被取消的会话任务', sessionId: 'sess-cancel', deliver: 'queue', originThreadId: 'source-A' })
    expectDispatched(session, gateway, '派发(session)')
    assert.equal(session.status, 202)
    const cancelled = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: session.body.taskId, originThreadId: 'source-A', force: true })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.cancelled, true)
    const after = await getJson(statusUrl(gateway.url, session.body.taskId, 'source-A'))
    assert.equal(after.body.status, 'cancelled')
  } finally {
    await gateway.close()
  }
})
