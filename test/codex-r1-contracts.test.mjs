/**
 * R1 契约回归（把独立评审复现的场景固化进项目测试）。
 *
 * 全部用**真实 HTTP 请求 + 独立 MCP/CLI 进程**，只碰临时 root：
 *   C1 显式非法来源一律拒绝且零执行（只有"字段未传"才是旧的无关联模式）
 *   C2 已关联任务缺来源 → origin-required、错来源 → origin-mismatch（内存与磁盘一致，不返回结果）
 *   C3 同 cwd+lane 有在途任务 → 明确 busy 拒绝（不把完成结果猜给某个 pending）；不同 lane 仍并行
 *   C4 旧网关不支持持久来源绑定时，来源模式**零执行**拒绝；旧的无来源调用仍兼容
 *   C5 只给来源列任务时，本实例没有运行上下文的非终态记录只能标 unknown（不谎报仍在观察）
 *
 * 跑法: node test/codex-r1-contracts.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  CLI_PATH,
  MCP_PATH,
  disposeAll,
  makeTmp,
  mcpCall,
  mcpInit,
  payloadOf,
  runCli,
  runMcp,
  startGateway,
  tick,
} from './helpers/dsh-host.mjs'

after(async () => { await disposeAll() })

const postJson = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let parsed = null
  try { parsed = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body: parsed }
}
const getJson = async (url) => {
  const res = await fetch(url)
  let parsed = null
  try { parsed = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body: parsed }
}

// ---------------------------------------------------------------- C1

test('C1: 显式非法 originThreadId 一律拒绝且零执行；只有字段未传才是无关联模式', async () => {
  const assocRoot = await makeTmp('dsh-r1-c1-')
  const gateway = await startGateway({ assocRoot })
  const url = gateway.url + '/api/dsh-bridge/task'

  for (const [label, value] of [['empty', ''], ['null', null], ['number', 123], ['whitespace', '  '], ['bool', true], ['array', ['a']], ['object', {}]]) {
    const res = await postJson(url, { instruction: 'fixture-only', cwd: 'E:/fixture/invalid-' + label, originThreadId: value })
    assert.notEqual(res.status, 202, 'invalid origin (' + label + ') must not be accepted')
    assert.equal(res.body.reason, 'invalid-origin', 'invalid origin (' + label + ') must be reported as invalid-origin')
  }
  assert.equal(gateway.starts.length, 0, 'invalid origin must never execute a task')
  assert.equal(gateway.owners.length, 0)
  assert.equal(gateway.store === undefined ? 0 : 0, 0)

  // 字段未传 → 旧的无关联模式仍然可用
  const legacy = await postJson(url, { instruction: 'legacy unbound', cwd: 'E:/fixture/legacy-ok' })
  assert.equal(legacy.status, 202)
  assert.equal(legacy.body.originThreadId, undefined)
  assert.equal(gateway.starts.length, 1)
})

// ---------------------------------------------------------------- C2

test('C2: 已关联任务缺来源 → origin-required、错来源 → origin-mismatch（内存里也不返回结果）', async () => {
  const assocRoot = await makeTmp('dsh-r1-c2-')
  const gateway = await startGateway({ assocRoot })
  const url = gateway.url + '/api/dsh-bridge/task'

  const dispatched = await postJson(url, { instruction: 'bound task', cwd: 'E:/fixture/c2', originThreadId: 'source-A' })
  assert.equal(dispatched.status, 202)
  assert.equal(gateway.complete('bound task', 'source-A-result'), true)
  await tick()

  const exact = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + dispatched.body.taskId + '&originThreadId=source-A')
  assert.equal(exact.status, 200)
  assert.equal(exact.body.result, 'source-A-result')

  const missing = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + dispatched.body.taskId)
  assert.notEqual(missing.status, 200, 'a missing source must not read a bound result')
  assert.equal(missing.body.reason, 'origin-required')
  assert.equal(missing.body.result, undefined)
  assert.equal(missing.body.instruction, undefined)

  const wrong = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + dispatched.body.taskId + '&originThreadId=source-B')
  assert.notEqual(wrong.status, 200)
  assert.equal(wrong.body.reason, 'origin-mismatch')
  assert.equal(wrong.body.result, undefined)

  // 取消入口同样要来源
  const cancelMissing = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: dispatched.body.taskId })
  assert.equal(cancelMissing.status, 404)
  assert.equal(cancelMissing.body.reason, 'origin-required')
  const cancelWrong = await postJson(gateway.url + '/api/dsh-bridge/cancel', { taskId: dispatched.body.taskId, originThreadId: 'source-B' })
  assert.equal(cancelWrong.body.reason, 'origin-mismatch')
})

// ---------------------------------------------------------------- C3

test('C3: 同通道有在途任务 → 明确 busy 拒绝（零 followup、零二次执行）；不同 lane 并行', async () => {
  const assocRoot = await makeTmp('dsh-r1-c3-')
  const gateway = await startGateway({ assocRoot })
  const url = gateway.url + '/api/dsh-bridge/task'

  const a = await postJson(url, { instruction: 'A 的任务', cwd: 'E:/fixture/shared', lane: 'main', originThreadId: 'source-A' })
  assert.equal(a.status, 202)

  // 关联 B（同通道）
  const b = await postJson(url, { instruction: 'B 的任务', cwd: 'E:/fixture/shared', lane: 'main', originThreadId: 'source-B' })
  assert.notEqual(b.status, 202, '同通道第二个任务必须被拒绝')
  assert.equal(b.body.reason, 'worker-bucket-busy')
  // 旧的无来源调用也不得借机插队并偷走归属
  const legacySame = await postJson(url, { instruction: '无来源的第二个任务', cwd: 'E:/fixture/shared', lane: 'main' })
  assert.notEqual(legacySame.status, 202)
  assert.equal(legacySame.body.reason, 'worker-bucket-busy')

  assert.equal(gateway.followups.length, 0, '第二次派活绝不能变成 followup（完成归属会变成猜测）')
  assert.equal(gateway.starts.length, 1, '同通道只允许一次执行')

  // 不同 lane → 并行，允许
  const otherLane = await postJson(url, { instruction: '另一个 lane 的任务', cwd: 'E:/fixture/shared', lane: 'lane-2', originThreadId: 'source-B' })
  assert.equal(otherLane.status, 202)
  assert.equal(gateway.starts.length, 2)

  // A 完成后，同通道可以再派活（继续同一个子代理的上下文）
  assert.equal(gateway.complete('A 的任务', 'A 的结果'), true)
  await tick()
  const afterDone = await postJson(url, { instruction: 'A 之后的同通道任务', cwd: 'E:/fixture/shared', lane: 'main', originThreadId: 'source-A' })
  assert.equal(afterDone.status, 202)

  // 评审同样防护
  const review1 = await postJson(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/fixture/review', diff: 'd', originThreadId: 'source-A' })
  assert.equal(review1.status, 202)
  const review2 = await postJson(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/fixture/review', diff: 'd2', originThreadId: 'source-B' })
  assert.equal(review2.body.reason, 'reviewer-bucket-busy')
})

// ---------------------------------------------------------------- C4

/** 旧网关：忽略 originThreadId、也不上报 capabilities；统计真实的派活 POST。 */
const startLegacyGateway = async () => {
  let posts = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const isPost = req.method === 'POST'
      const input = body === '' ? {} : JSON.parse(body)
      const dryRun = isPost && input.dryRun === true
      if (isPost && !dryRun) posts++
      res.writeHead(isPost ? 202 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(dryRun
        ? { dryRun: true, resolved: true, target: { kind: 'worker' } }
        : (isPost ? { taskId: 'fixture-legacy-task', status: 'accepted', delivered: true, target: { kind: 'worker' } } : { pending: 0, tasks: [] })))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    posts: () => posts,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('C4: 旧网关不支持持久来源绑定 → MCP 与 CLI 在派活前拒绝（零执行）', async () => {
  const legacy = await startLegacyGateway()
  try {
    // MCP：带来源 → 拒绝，且一个派活 POST 都没有
    const mcp = await runMcp({ DSH_BRIDGE_URL: legacy.url }, [
      mcpInit(1),
      mcpCall(2, 'dsh_task', { instruction: 'fixture-only', cwd: 'E:/fixture/legacy', originThreadId: 'source-A', wait: false }),
      // 显式非法来源也不能被丢掉
      mcpCall(3, 'dsh_task', { instruction: 'fixture-only', cwd: 'E:/fixture/legacy2', originThreadId: '', wait: false }),
      // 按来源查询也不能把旧网关的普通响应当成精确恢复
      mcpCall(4, 'dsh_task_status', { taskId: 'fixture-legacy-task', originThreadId: 'source-A' }),
    ])
    const unsupported = payloadOf(mcp.get(2))
    assert.notEqual(unsupported.ok, true)
    assert.equal(unsupported.reason, 'origin-binding-unsupported')
    assert.equal(payloadOf(mcp.get(3)).reason, 'invalid-origin')
    assert.equal(payloadOf(mcp.get(4)).reason, 'origin-binding-unsupported')
    assert.equal(legacy.posts(), 0, 'bound MCP dispatch must not POST to an older gateway')

    // CLI：带来源 → 非零退出，且零派活 POST
    const cli = await runCli(['--in', 'fixture-only', '--cwd', 'E:/fixture/legacy', '--no-wait', '--origin', 'source-A', '--require-origin'], { DSH_BRIDGE_URL: legacy.url })
    assert.notEqual(cli.status, 0)
    assert.match(cli.stderr, /不支持持久来源绑定/)
    assert.equal(legacy.posts(), 0, 'CLI must not silently dispatch an unbound task to an older gateway')

    // 旧的无来源调用仍然兼容（这条会真的 POST）
    const legacyCli = await runCli(['--in', 'legacy dispatch', '--cwd', 'E:/fixture/legacy3', '--no-wait'], { DSH_BRIDGE_URL: legacy.url, CODEX_THREAD_ID: '' })
    assert.equal(legacyCli.status, 0, legacyCli.stderr)
    assert.equal(legacy.posts(), 1, '无来源的旧调用必须保持兼容')
  } finally {
    await legacy.close()
  }
})

test('C4b: 支持来源的网关会明确上报能力；客户端据此放行', async () => {
  const assocRoot = await makeTmp('dsh-r1-c4b-')
  const gateway = await startGateway({ assocRoot })

  for (const url of ['/api/dsh-bridge/status', '/api/dsh-bridge/tasks', '/api/dsh-bridge/debug']) {
    const res = await getJson(gateway.url + url)
    assert.equal(res.body.capabilities.originBinding.supported, true, url + ' 必须上报来源绑定能力')
    assert.equal(res.body.capabilities.originBinding.version, 1)
  }

  // 真实 MCP 进程在支持来源的网关上照常派活并落盘
  const mcp = await runMcp({ DSH_BRIDGE_URL: gateway.url }, [
    mcpInit(1),
    mcpCall(2, 'dsh_task', { instruction: 'mcp 正常派活', cwd: 'E:/fixture/c4b', originThreadId: 'source-MCP', wait: false }),
  ])
  const submitted = payloadOf(mcp.get(2))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.originThreadId, 'source-MCP')
  assert.equal(gateway.starts.length, 1)
})

// ---------------------------------------------------------------- C5

test('C5: 只给来源列任务时，没有本实例运行上下文的非终态记录只能标 unknown', async () => {
  const assocRoot = await makeTmp('dsh-r1-c5-')
  const first = await startGateway({ assocRoot })
  const url = first.url + '/api/dsh-bridge/task'

  const done = await postJson(url, { instruction: '跑完的', cwd: 'E:/fixture/c5-done', originThreadId: 'source-C5' })
  assert.equal(first.complete('跑完的', 'c5 结果'), true)
  await tick()
  const pending = await postJson(url, { instruction: '没跑完的', cwd: 'E:/fixture/c5-pending', originThreadId: 'source-C5' })
  assert.equal(pending.status, 202)
  await first.close()

  // 新实例（同一持久 root）：列表里那条非终态记录必须标 unknown，不能显示 accepted/running
  const second = await startGateway({ assocRoot })
  const listed = await getJson(second.url + '/api/dsh-bridge/status?originThreadId=source-C5')
  assert.equal(listed.status, 200)
  const byId = new Map(listed.body.tasks.map((t) => [t.taskId, t]))
  assert.equal(byId.get(done.body.taskId).status, 'done')
  assert.equal(byId.get(done.body.taskId).result, 'c5 结果')
  const stored = byId.get(pending.body.taskId)
  assert.equal(stored.status, 'unknown', '没有运行上下文的非终态记录不得谎报为 accepted/running')
  assert.equal(stored.persistedStatus, 'accepted')
  assert.equal(stored.resend, false)
  assert.equal(stored.reason, 'execution-state-unconfirmed')
  assert.equal(stored.live, false)
  assert.deepEqual(stored.target, { kind: 'worker', cwd: 'E:\\fixture\\c5-pending', lane: 'main' })

  // /tasks 走来源过滤时语义一致
  const tasksRoute = await getJson(second.url + '/api/dsh-bridge/tasks?originThreadId=source-C5')
  const viaTasks = new Map(tasksRoute.body.tasks.map((t) => [t.taskId, t]))
  assert.equal(viaTasks.get(pending.body.taskId).status, 'unknown')
  assert.equal(second.starts.length, 0, '恢复/列表路径绝不启动新执行')
})

// ---------------------------------------------------------------- CLI 严格参数

/** "变脸"网关：能力检查时自称支持来源，但接受 POST 后**不回显** originThreadId（结果也不确认来源）。 */
const startUnconfirmingGateway = async () => {
  let posts = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST') posts++
      const body = req.method === 'POST'
        ? { taskId: 'fixture-changed-task', status: 'accepted', delivered: true, target: { kind: 'worker' } }
        : (req.url.includes('taskId=')
            ? { taskId: 'fixture-changed-task', status: 'done', result: 'UNCONFIRMED RESULT FROM OLD HANDLER' }
            : { capabilities: { originBinding: { supported: true, version: 1 } }, tasks: [] })
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    posts: () => posts,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('C4c: 能力检查通过但网关未确认来源 → 未确认 + 禁止重发（MCP/CLI 都不当成功或精确取值）', async () => {
  const gateway = await startUnconfirmingGateway()
  try {
    // MCP 派活：POST 确实发生了（不是零执行拒绝），但绑定没被确认 → ok:false + resend:false
    const dispatchTurn = await runMcp({ DSH_BRIDGE_URL: gateway.url }, [
      mcpInit(1),
      mcpCall(2, 'dsh_task', { instruction: 'fixture-only', cwd: 'E:/fixture/reload', originThreadId: 'source-A', wait: false }),
    ])
    const dispatched = payloadOf(dispatchTurn.get(2))
    assert.equal(gateway.posts(), 1, '接受动作确实发生，因此这不是"零执行拒绝"')
    assert.notEqual(dispatched.ok, true)
    assert.equal(dispatched.resend, false, '任务可能已经执行 → 绝不能重发')
    assert.equal(dispatched.reason, 'origin-not-confirmed')

    // MCP 取值：没确认来源就不算精确恢复，绝不能透出 result
    const statusTurn = await runMcp({ DSH_BRIDGE_URL: gateway.url }, [
      mcpInit(1),
      mcpCall(2, 'dsh_task_status', { taskId: 'fixture-changed-task', originThreadId: 'source-A' }),
    ])
    const status = payloadOf(statusTurn.get(2))
    assert.equal(status.result, undefined, '未确认来源的响应不得返回结果')
    assert.notEqual(status.status, 'done')
    assert.equal(status.resend, false)

    // CLI 派活：非零退出 + resend:false
    const cliDispatch = await runCli(['--in', 'fixture-only', '--cwd', 'E:/fixture/reload', '--no-wait', '--origin', 'source-A', '--require-origin'], { DSH_BRIDGE_URL: gateway.url })
    assert.notEqual(cliDispatch.status, 0)
    assert.equal(JSON.parse(cliDispatch.stdout.trim().split('\n').pop()).resend, false)

    // CLI 取值：非零退出，且**不能**把网关 body 里的结果打印出来
    const cliStatus = await runCli(['--status', 'fixture-changed-task', '--origin', 'source-A'], { DSH_BRIDGE_URL: gateway.url })
    assert.notEqual(cliStatus.status, 0)
    assert.equal(cliStatus.stdout.includes('UNCONFIRMED RESULT FROM OLD HANDLER'), false)
  } finally {
    await gateway.close()
  }
})

test('CLI: --origin 缺值 / 下一项是旗标 / 显式空值 都在请求前报用法错误（不回落 ENV）', async () => {
  const assocRoot = await makeTmp('dsh-r1-cli-')
  const gateway = await startGateway({ assocRoot })
  const env = { DSH_BRIDGE_URL: gateway.url, CODEX_THREAD_ID: 'env-should-not-be-used' }
  const startsBefore = gateway.starts.length

  for (const args of [['--my-tasks', '--origin'], ['--my-tasks', '--origin', '--force'], ['--my-tasks', '--origin', '   ']]) {
    const res = await runCli(args, env)
    assert.equal(res.status, 2, 'args=' + JSON.stringify(args) + ' 必须以用法错误退出')
    assert.match(res.stderr, /--origin 需要一个值/)
  }
  assert.equal(gateway.starts.length, startsBefore, '用法错误不得产生任何派活')

  // 显式 --origin 合法时优先于 ENV；ENV 仅在未显式给时兜底
  const explicit = await runCli(['--in', 'explicit origin', '--cwd', 'E:/fixture/cli-explicit', '--no-wait', '--origin', 'source-EXPLICIT'], env)
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.match(explicit.stderr, /originThreadId=source-EXPLICIT（--origin）/)
  const viaEnv = await runCli(['--in', 'env origin', '--cwd', 'E:/fixture/cli-env', '--no-wait'], env)
  assert.equal(viaEnv.status, 0, viaEnv.stderr)
  assert.match(viaEnv.stderr, /originThreadId=env-should-not-be-used（CODEX_THREAD_ID）/)
})
