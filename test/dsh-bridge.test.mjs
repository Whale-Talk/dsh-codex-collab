/**
 * dsh-bridge.mjs 的路由级回归测试：用假 DSH 运行时触发真实 apply(ctx)。
 * 跑法: node --test test/*.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openAssociations } from '../harness/codex-associations.mjs'

let fixtureRoot
let bridgePromise
const assocRoots = []

const repoRoot = path.resolve(import.meta.dirname, '..')
const tmpParent = path.resolve(os.tmpdir())

const loadBridge = async () => {
  if (bridgePromise !== undefined) return bridgePromise
  bridgePromise = (async () => {
    fixtureRoot = await mkdtemp(path.join(tmpParent, 'dsh-bridge-test-'))
    await cp(path.join(repoRoot, 'harness'), path.join(fixtureRoot, 'harness'), { recursive: true })
    const stubRoot = path.join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    await mkdir(stubRoot, { recursive: true })
    await writeFile(path.join(stubRoot, 'package.json'), JSON.stringify({ type: 'module', main: './index.js', exports: './index.js' }), 'utf8')
    await writeFile(path.join(stubRoot, 'index.js'), 'export const defineTool = (tool) => tool\n', 'utf8')
    return import(pathToFileURL(path.join(fixtureRoot, 'harness', 'dsh-bridge.mjs')).href)
  })()
  return bridgePromise
}

after(async () => {
  if (fixtureRoot !== undefined) {
    const resolved = path.resolve(fixtureRoot)
    if (!resolved.startsWith(tmpParent + path.sep) || !path.basename(resolved).startsWith('dsh-bridge-test-')) {
      throw new Error('refusing to remove unexpected fixture path: ' + resolved)
    }
    await rm(resolved, { recursive: true, force: true })
  }
  // 关联存储用的临时 root：同样先校验解析后的绝对目标，再递归删除。
  for (const dir of assocRoots) {
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(tmpParent + path.sep)) continue
    if (!path.basename(resolved).startsWith('dsh-assoc-')) continue
    await rm(resolved, { recursive: true, force: true }).catch(() => {})
  }
})

const makeReq = (body) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/dsh-bridge/task'
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

const makeGetReq = (url) => {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => req.emit('end'))
  return req
}

const callReq = async (handler, req) => {
  let done
  const ended = new Promise((resolve) => { done = resolve })
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    end(chunk = '') {
      this.body += chunk
      done({
        statusCode: this.statusCode,
        headers: this.headers,
        body: this.body === '' ? undefined : JSON.parse(this.body),
      })
    },
  }
  await handler(req, res)
  return ended
}

const callJson = (handler, body) => callReq(handler, makeReq(body))
const callGet = (handler, url) => callReq(handler, makeGetReq(url))
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const makeHarness = async (options = {}) => {
  const { apply } = await loadBridge()
  const routes = new Map()
  const cleanups = []
  const starts = []
  const owners = []
  const prompts = []
  const followups = []
  const tools = []
  const ctxHandlers = new Map()
  const agentHandlers = new Map()
  const assocRoot = options.assocRoot === undefined ? await mkdtemp(path.join(tmpParent, 'dsh-assoc-')) : options.assocRoot
  assocRoots.push(assocRoot)
  const onCtx = (name, fn) => {
    const set = ctxHandlers.get(name) || new Set()
    set.add(fn)
    ctxHandlers.set(name, set)
    return () => set.delete(fn)
  }
  const onAgent = (name, fn) => {
    const set = agentHandlers.get(name) || new Set()
    set.add(fn)
    agentHandlers.set(name, set)
    return () => set.delete(fn)
  }
  const controller = {
    async resolveAgent(sessionId) {
      return { sessionId }
    },
    async prompt(args) {
      prompts.push(args)
      return {}
    },
    async *follow() {},
  }
  const ctx = {
    webServer: {
      exact: new Map(),
      upgrades: new Map(),
      register(route) {
        routes.set(route.path, route.handler)
        this.exact.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route) {
        this.upgrades.set(route.path, route.handler)
        return () => this.upgrades.delete(route.path)
      },
    },
    agents: {
      list() {
        return [{ options: { provider: 'fake-provider', model: 'fake-model' } }]
      },
      async create(options) {
        owners.push(options)
        return {
          agent: { id: 'owner-1', ctx: { on: onAgent } },
          dispose() {},
        }
      },
    },
    subagents: {
      list() {
        return ['subagent']
      },
      getProvider() {
        return { prepareContinuable() {} }
      },
      async startContinuable(args) {
        starts.push(args)
        return { childId: 'child-1' }
      },
      async followup(args) {
        followups.push(args)
        return {}
      },
      interrupt() {},
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    },
    on: onCtx,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  const previousAssocDir = process.env.DSH_BRIDGE_ASSOC_DIR
  process.env.DSH_BRIDGE_ASSOC_DIR = assocRoot
  try {
    await apply(ctx)
  } finally {
    if (previousAssocDir === undefined) delete process.env.DSH_BRIDGE_ASSOC_DIR
    else process.env.DSH_BRIDGE_ASSOC_DIR = previousAssocDir
  }
  return {
    routes,
    starts,
    owners,
    prompts,
    followups,
    tools,
    cleanups,
    assocRoot,
    /** 触发 ctx 事件（如 api-session/status）。 */
    emitCtx(name, ...args) {
      for (const fn of ctxHandlers.get(name) || []) fn(...args)
    },
    /** 触发子代理结束事件，驱动 worker/review 任务的真实完成路径。 */
    emitAgentEnd(info) {
      for (const fn of agentHandlers.get('subagent/end') || []) fn(info)
    },
    store() {
      return openAssociations({ root: assocRoot, namespace: 'default' })
    },
  }
}

test('POST /task: default worker dispatch starts a continuable subagent', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, {
    instruction: '跑一个 worker 回归测试',
    cwd: 'E:/tmp/dsh-worker',
    lane: 'main',
  })

  assert.equal(res.statusCode, 202)
  assert.equal(res.body.status, 'accepted')
  assert.deepEqual(res.body.target, { kind: 'worker', cwd: 'E:\\tmp\\dsh-worker', lane: 'main' })
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.starts[0].provider, 'subagent')
  assert.equal(harness.starts[0].label, 'codex-collab-worker-main')
  assert.match(harness.starts[0].request.prompt[0].text, /跑一个 worker 回归测试/)
})

test('POST /task: session dispatch preserves queue and steer delivery modes', async () => {
  for (const mode of ['queue', 'steer']) {
    const harness = await makeHarness()
    const task = harness.routes.get('/api/dsh-bridge/task')

    const res = await callJson(task, {
      instruction: '投递到已有会话',
      target: { kind: 'session', sessionId: 'session-' + mode },
      deliver: mode,
    })

    assert.equal(res.statusCode, 202)
    assert.equal(res.body.target.kind, 'session')
    assert.equal(res.body.target.deliver, mode)
    assert.equal(harness.prompts.length, 1)
    assert.equal(harness.prompts[0].mode, mode)
    assert.equal(harness.prompts[0].sessionId, 'session-' + mode)
    assert.deepEqual(harness.prompts[0].content, [{ type: 'text', text: '投递到已有会话' }])
    assert.equal(harness.starts.length, 0)
    assert.equal(harness.owners.length, 0)
  }
})

test('POST /task: session dispatch reports delivered once the prompt is accepted', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, {
    instruction: '投递并标记已送达',
    target: { kind: 'session', sessionId: 'session-delivered' },
  })

  assert.equal(res.statusCode, 202)
  // 关键：prompt 被接受就等于"消息已进会话队列"，调用方据此不再重发。
  assert.equal(res.body.delivered, true)
  assert.equal(harness.prompts.length, 1)
})

test('POST /task: dryRun resolves the target and never dispatches', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const session = await callJson(task, { dryRun: true, target: { kind: 'session', sessionId: 'session-probe' } })
  assert.equal(session.statusCode, 200)
  assert.equal(session.body.dryRun, true)
  assert.equal(session.body.resolved, true)
  assert.equal(session.body.target.sessionId, 'session-probe')
  assert.equal(harness.prompts.length, 0)

  const worker = await callJson(task, { dryRun: true, cwd: 'E:/tmp/dry-run', lane: 'main' })
  assert.equal(worker.statusCode, 200)
  assert.deepEqual(worker.body.target, { kind: 'worker', cwd: 'E:\\tmp\\dry-run', lane: 'main' })
  assert.equal(harness.starts.length, 0)
  assert.equal(harness.owners.length, 0)
})

// ---------------------------------------------------------------- R1：来源关联与跨回合恢复

test('R1: 带 originThreadId 派活 → 执行前落盘关联，响应回显来源', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, { instruction: '带来源的 worker 任务', cwd: 'E:/tmp/r1-worker', originThreadId: 'origin-A' })

  assert.equal(res.statusCode, 202)
  assert.equal(res.body.originThreadId, 'origin-A')
  assert.equal(harness.starts.length, 1, '已派活')
  const record = harness.store().fetch({ originThreadId: 'origin-A', taskId: res.body.taskId })
  assert.equal(record.ok, true, '执行前必须已经落盘关联')
  assert.equal(record.record.status, 'accepted')
  assert.deepEqual(record.record.target, { kind: 'worker', cwd: 'E:\\tmp\\r1-worker', lane: 'main' })
})

test('R1: 非法 originThreadId → 400，零派活、零关联', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  for (const bad of ['   ', 'x\u0000y', 'a'.repeat(201)]) {
    const res = await callJson(task, { instruction: '不该派出去', cwd: 'E:/tmp/r1-bad', originThreadId: bad })
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.reason, 'invalid-origin')
  }
  assert.equal(harness.starts.length, 0, '非法来源绝不派活')
  assert.equal(harness.store().count(), 0, '非法来源绝不写关联')
})

test('R1: dryRun 带 origin → 零派活、零关联写入', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, { dryRun: true, instruction: '(dry-run)', cwd: 'E:/tmp/r1-dry', originThreadId: 'origin-A' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.wouldDispatch, true)
  assert.equal(harness.starts.length, 0)
  assert.equal(harness.store().count(), 0, 'dryRun 不得写任何关联记录')
})

test('R1: worker 完成 → 终态与结果写回持久关联记录', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, { instruction: '要跑完的 worker 任务', cwd: 'E:/tmp/r1-done', originThreadId: 'origin-A' })
  harness.emitAgentEnd({ id: 'child-1', lastAssistantMessage: [{ type: 'text', text: '任务完成正文' }], stopReason: 'end_turn' })
  await tick()

  const record = harness.store().record(res.body.taskId)
  assert.equal(record.status, 'done')
  assert.equal(record.result, '任务完成正文')
  assert.equal(record.stopReason, 'end_turn')
  assert.equal(record.originThreadId, 'origin-A')
})

test('R1: 按来源精确取值；错来源/未知任务拒绝；只给来源列出该对话的任务', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')
  const status = harness.routes.get('/api/dsh-bridge/status')

  const a = await callJson(task, { instruction: 'A 的任务', cwd: 'E:/tmp/r1-a', originThreadId: 'origin-A' })
  harness.emitAgentEnd({ id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'A 结果' }], stopReason: 'end_turn' })
  await tick()
  const b = await callJson(task, { instruction: 'B 的任务', cwd: 'E:/tmp/r1-b', originThreadId: 'origin-B' })

  const exact = await callGet(status, '/api/dsh-bridge/status?taskId=' + a.body.taskId + '&originThreadId=origin-A')
  assert.equal(exact.statusCode, 200)
  assert.equal(exact.body.result, 'A 结果')
  assert.equal(exact.body.originThreadId, 'origin-A')

  // 错来源：绝不返回别的对话的结果
  const wrong = await callGet(status, '/api/dsh-bridge/status?taskId=' + a.body.taskId + '&originThreadId=origin-B')
  assert.equal(wrong.statusCode, 404)
  assert.equal(wrong.body.reason, 'origin-mismatch')
  assert.equal(wrong.body.result, undefined)
  assert.equal(wrong.body.instruction, undefined)

  // 只给来源：列出该对话登记过的任务（用来找回丢失的 taskId）
  const listed = await callGet(status, '/api/dsh-bridge/status?originThreadId=origin-A')
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.body.tasks.map((t) => t.taskId), [a.body.taskId])
  assert.equal(listed.body.tasks[0].live, true)

  const listedB = await callGet(status, '/api/dsh-bridge/status?originThreadId=origin-B')
  assert.deepEqual(listedB.body.tasks.map((t) => t.taskId), [b.body.taskId])

  // 已关联任务缺来源：必须拒绝（内存里也不给），且不返回结果
  const noOrigin = await callGet(status, '/api/dsh-bridge/status?taskId=' + a.body.taskId)
  assert.equal(noOrigin.statusCode, 404)
  assert.equal(noOrigin.body.reason, 'origin-required')
  assert.equal(noOrigin.body.result, undefined)

  // 真正"未关联"的旧任务：仍支持只按 taskId 查询（兼容）
  const legacyTask = await callJson(task, { instruction: '旧的无来源任务', cwd: 'E:/tmp/r1-legacy' })
  assert.equal(legacyTask.statusCode, 202)
  assert.equal(legacyTask.body.originThreadId, undefined)
  const legacy = await callGet(status, '/api/dsh-bridge/status?taskId=' + legacyTask.body.taskId)
  assert.equal(legacy.statusCode, 200)
  assert.equal(legacy.body.status, 'accepted')
})

test('R1: 新网关实例按 origin+taskId 恢复已完成结果；未完成任务标 unknown 且不重新派活', async () => {
  const assocRoot = await mkdtemp(path.join(tmpParent, 'dsh-assoc-restart-'))
  const first = await makeHarness({ assocRoot })
  const taskRoute = first.routes.get('/api/dsh-bridge/task')

  const done = await callJson(taskRoute, { instruction: '重启前完成', cwd: 'E:/tmp/r1-restart', originThreadId: 'origin-A' })
  first.emitAgentEnd({ id: 'child-1', lastAssistantMessage: [{ type: 'text', text: '重启前的结果' }], stopReason: 'end_turn' })
  await tick()
  const inFlight = await callJson(taskRoute, { instruction: '重启前没跑完', cwd: 'E:/tmp/r1-restart2', originThreadId: 'origin-A' })

  // 新实例：同一持久 root，全新内存表
  const second = await makeHarness({ assocRoot })
  const status = second.routes.get('/api/dsh-bridge/status')

  const recovered = await callGet(status, '/api/dsh-bridge/status?taskId=' + done.body.taskId + '&originThreadId=origin-A')
  assert.equal(recovered.statusCode, 200)
  assert.equal(recovered.body.status, 'done')
  assert.equal(recovered.body.result, '重启前的结果')
  assert.equal(recovered.body.recovered, true)
  assert.deepEqual(recovered.body.target, { kind: 'worker', cwd: 'E:\\tmp\\r1-restart', lane: 'main' })

  const unconfirmed = await callGet(status, '/api/dsh-bridge/status?taskId=' + inFlight.body.taskId + '&originThreadId=origin-A')
  assert.equal(unconfirmed.statusCode, 200)
  assert.equal(unconfirmed.body.status, 'unknown', '不得谎报已完成')
  assert.equal(unconfirmed.body.persistedStatus, 'accepted')
  assert.equal(unconfirmed.body.reason, 'execution-state-unconfirmed')
  assert.equal(unconfirmed.body.resend, false, '必须明确"不要重发"')
  assert.deepEqual(unconfirmed.body.target, { kind: 'worker', cwd: 'E:\\tmp\\r1-restart2', lane: 'main' })

  // 恢复路径不启动任何新执行
  assert.equal(second.starts.length, 0)
  assert.equal(second.owners.length, 0)

  // 缺来源时明确拒绝（不猜、不按最近对话）
  const noOrigin = await callGet(status, '/api/dsh-bridge/status?taskId=' + done.body.taskId)
  assert.equal(noOrigin.statusCode, 404)
  assert.equal(noOrigin.body.reason, 'origin-required')
  assert.match(noOrigin.body.hint, /originThreadId/)

  // 错来源
  const wrong = await callGet(status, '/api/dsh-bridge/status?taskId=' + done.body.taskId + '&originThreadId=origin-B')
  assert.equal(wrong.statusCode, 404)
  assert.equal(wrong.body.reason, 'origin-mismatch')

  // 新实例只给来源也能列出（找回 taskId）
  const mine = await callGet(status, '/api/dsh-bridge/status?originThreadId=origin-A')
  assert.deepEqual(mine.body.tasks.map((t) => t.taskId).sort(), [done.body.taskId, inFlight.body.taskId].sort())
  assert.equal(mine.body.tasks.every((t) => t.live === false), true)
})

test('R1: 会话目标与评审同样持久关联；取消写回终态', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')
  const review = harness.routes.get('/api/dsh-bridge/review')
  const cancel = harness.routes.get('/api/dsh-bridge/cancel')
  const status = harness.routes.get('/api/dsh-bridge/status')

  const session = await callJson(task, { instruction: '投递给会话', target: { kind: 'session', sessionId: 'session-r1' }, originThreadId: 'origin-A' })
  assert.equal(session.body.originThreadId, 'origin-A')
  assert.equal(harness.store().record(session.body.taskId).status, 'accepted')
  // prompt 必须带上 requestId=taskId（SDK 会把它写进 user/message.source.rpcId）
  assert.equal(harness.prompts[0].requestId, session.body.taskId)

  // 会话 running→idle，但日志里**没有**匹配本请求 requestId 的 turn：
  // 精确关联模式下这**不是**完成证明（只有自己那个 turn 的 turn/end 才算）。
  harness.emitCtx('api-session/status', 'session-r1', true)
  harness.emitCtx('api-session/status', 'session-r1', false)
  await tick()
  const notDone = await callGet(status, '/api/dsh-bridge/status?taskId=' + session.body.taskId + '&originThreadId=origin-A')
  assert.notEqual(notDone.body.status, 'done', '没有匹配 turn 的证据时绝不能判完成')
  assert.equal(notDone.body.result, undefined)
  assert.notEqual(harness.store().record(session.body.taskId).status, 'done')
  // 会话任务完成后写回 delivered 的行为在 test/codex-session-correlation.test.mjs 用真实 SDK 字段覆盖。

  const reviewTask = await callJson(review, { cwd: 'E:/tmp/r1-review', diff: 'diff', focus: '重点', originThreadId: 'origin-A' })
  assert.equal(reviewTask.statusCode, 202)
  assert.equal(reviewTask.body.originThreadId, 'origin-A')
  assert.equal(harness.store().record(reviewTask.body.taskId).kind, 'review')

  const toCancel = await callJson(task, { instruction: '会被取消', cwd: 'E:/tmp/r1-cancel', originThreadId: 'origin-A' })
  const cancelled = await callJson(cancel, { taskId: toCancel.body.taskId, originThreadId: 'origin-A' })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(harness.store().record(toCancel.body.taskId).status, 'cancelled')

  // 别的来源不能取消它
  const other = await callJson(task, { instruction: '另一个来源的任务', cwd: 'E:/tmp/r1-cancel2', originThreadId: 'origin-B' })
  const crossCancel = await callJson(cancel, { taskId: other.body.taskId, originThreadId: 'origin-A' })
  assert.equal(crossCancel.statusCode, 404)
  assert.equal(crossCancel.body.reason, 'origin-mismatch')
})

test('R1: 关联存储不可用 → 拒绝派活（绝不"执行了却没绑定"）', async () => {
  // 让 namespace 子目录的位置被一个文件占住：bind 时 ensureDir 必然失败 → 必须拒绝派活。
  const bogusRoot = await mkdtemp(path.join(tmpParent, 'dsh-assoc-bogus-'))
  await writeFile(path.join(bogusRoot, 'default'), 'this is a file, not a directory', 'utf8')
  const harness = await makeHarness({ assocRoot: bogusRoot })
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, { instruction: '不该在无关联存储时执行', cwd: 'E:/tmp/r1-nostore', originThreadId: 'origin-A' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.reason, 'association-bind-failed')
  assert.equal(harness.starts.length, 0, '绑定失败绝不启动 DSH 执行')
  assert.equal(harness.owners.length, 0)

  // 不带来源的旧调用仍然可用（不因关联存储故障而瘫痪）
  const legacy = await callJson(task, { instruction: '无来源的旧调用', cwd: 'E:/tmp/r1-nostore2' })
  assert.equal(legacy.statusCode, 202)
})

test('R1: 200+ 已完成记录后旧关联结果仍可查，活关联任务仍能完成', async () => {
  const assocRoot = await mkdtemp(path.join(tmpParent, 'dsh-assoc-bulk-'))
  const harness = await makeHarness({ assocRoot })
  const task = harness.routes.get('/api/dsh-bridge/task')
  const ids = []

  for (let i = 0; i < 205; i++) {
    const res = await callJson(task, { instruction: 'bulk ' + i, cwd: 'E:/tmp/r1-bulk', originThreadId: 'origin-bulk' })
    assert.equal(res.statusCode, 202)
    ids.push(res.body.taskId)
    harness.emitAgentEnd({ id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'r-' + i }], stopReason: 'end_turn' })
  }
  assert.equal(harness.store().count(), 205, '持久记录不受内存 200 条上限影响')

  // 最旧的一条已被内存淘汰 → 必须从持久记录恢复
  const oldest = await callGet(harness.routes.get('/api/dsh-bridge/status'), '/api/dsh-bridge/status?taskId=' + ids[0] + '&originThreadId=origin-bulk')
  assert.equal(oldest.statusCode, 200)
  assert.equal(oldest.body.status, 'done')
  assert.equal(oldest.body.recovered, true)
  assert.equal(oldest.body.result, 'r-0')

  // 活关联任务仍能完成（淘汰不得把还在执行的任务挤掉）
  const fresh = await callJson(task, { instruction: 'bulk fresh', cwd: 'E:/tmp/r1-bulk', originThreadId: 'origin-bulk' })
  harness.emitAgentEnd({ id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'fresh done' }], stopReason: 'end_turn' })
  await tick()
  const freshRecord = harness.store().record(fresh.body.taskId)
  assert.equal(freshRecord.status, 'done')
  assert.equal(freshRecord.result, 'fresh done')
})
