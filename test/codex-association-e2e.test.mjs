/**
 * R1 端到端：**真实 HTTP 服务器 + 独立 MCP 进程 + 独立 CLI 进程**（不是 mock 返回对象）。
 *
 * 覆盖验收：
 *   - 两个独立 MCP 进程模拟两个回合：第二回合只给来源能发现任务，再按 origin+taskId 精确取结果；
 *   - MCP 只用显式 originThreadId（环境里的 CODEX_THREAD_ID 不得被当真）；
 *   - 错来源/缺来源一律拒绝且不串号；
 *   - 网关新实例（同一持久 root）恢复已完成结果；未完成任务标未知且**不重新派活**；
 *   - 两个独立 CLI 进程同样能按来源收取；无来源时 --my-tasks 如实拒绝；CODEX_THREAD_ID 可兜底。
 *
 * 宿主/子进程/临时目录管理都在 test/helpers/dsh-host.mjs：CLI 一律异步 spawn（HTTP 网关就跑在
 * 调用方事件循环里，同步 spawn 会自锁），MCP 收尾会**等到 close**，失败的测试也不会留下监听句柄。
 * 跑法: node test/codex-association-e2e.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { openAssociations } from '../harness/codex-associations.mjs'
import {
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

test('端到端（MCP×2 进程）：回合1 派活落盘 → 回合2 只给来源找到任务并按 origin+taskId 取结果；错来源拒绝', async () => {
  const assocRoot = await makeTmp('dsh-e2e-assoc-')
  const gateway = await startGateway({ assocRoot })
  try {
    // 回合 1：独立 MCP 进程。环境里故意放一个 CODEX_THREAD_ID——MCP **不得**把它当来源。
    const turn1 = await runMcp(
      { DSH_BRIDGE_URL: gateway.url, CODEX_THREAD_ID: 'env-must-not-be-used' },
      [mcpInit(1), mcpCall(2, 'dsh_task', { instruction: 'MCP 派活', cwd: 'E:/tmp/e2e-mcp', originThreadId: 'origin-MCP', wait: false })],
    )
    const submitted = payloadOf(turn1.get(2))
    // 先断言"真的提交成功 + 来源 + taskId"，否则 202/accepted 会把拒绝悄悄带过
    assert.equal(submitted.ok, true, 'MCP 派活必须真的成功: ' + JSON.stringify(submitted))
    assert.equal(submitted.originThreadId, 'origin-MCP', 'MCP 必须只用显式传入的来源，不能用常驻进程环境')
    assert.notEqual(submitted.originThreadId, 'env-must-not-be-used')
    assert.equal(typeof submitted.taskId === 'string' && submitted.taskId !== '', true, '必须返回 taskId: ' + JSON.stringify(submitted))
    const taskId = submitted.taskId
    // **有上限地**等 worker 真正注册（accepted 不等于已启动），再结清；超时给出诊断
    assert.equal(await gateway.waitForChild('MCP 派活', { timeoutMs: 5000 }), true,
      'worker 必须在时限内真正启动: ' + JSON.stringify({ payload: submitted, starts: gateway.starts.length, children: gateway.childMarkers() }))
    assert.equal(gateway.starts.length, 1)

    assert.equal(gateway.complete('MCP 派活', 'MCP 任务结果'), true)
    await tick()

    // 回合 2：**另一个** MCP 进程，不带任务记忆，只凭来源找回
    const turn2 = await runMcp(
      { DSH_BRIDGE_URL: gateway.url },
      [
        mcpInit(1),
        mcpCall(2, 'dsh_task_status', { originThreadId: 'origin-MCP' }),
        mcpCall(3, 'dsh_task_status', { taskId, originThreadId: 'origin-MCP' }),
        mcpCall(4, 'dsh_task_status', { taskId, originThreadId: 'origin-OTHER' }),
        mcpCall(5, 'dsh_task_status', { taskId }),
        mcpCall(6, 'dsh_task', { instruction: '越权来源', cwd: 'E:/tmp/e2e-mcp2', originThreadId: '  ', wait: false }),
      ],
    )
    const listed = payloadOf(turn2.get(2))
    assert.deepEqual(listed.tasks.map((t) => t.taskId), [taskId], '只给来源必须能发现该任务')
    const exact = payloadOf(turn2.get(3))
    assert.equal(exact.status, 'done')
    assert.equal(exact.result, 'MCP 任务结果')
    const wrong = payloadOf(turn2.get(4))
    assert.equal(wrong.reason, 'origin-mismatch')
    assert.equal(wrong.result, undefined, '错来源绝不返回别人的结果')
    const missing = payloadOf(turn2.get(5))
    assert.equal(missing.reason, 'origin-required', '缺来源绝不返回已关联结果')
    assert.equal(missing.result, undefined)

    const invalid = payloadOf(turn2.get(6))
    assert.equal(invalid.ok, false)
    assert.equal(invalid.reason, 'invalid-origin')
    assert.equal(gateway.starts.length, 1, '非法来源绝不派活')
  } finally {
    await gateway.close()
  }
})

test('端到端（MCP + 网关新实例）：已完成按 origin+taskId 恢复；未完成标 unknown 且不重新派活', async () => {
  const assocRoot = await makeTmp('dsh-e2e-restart-')
  const first = await startGateway({ assocRoot })
  let second
  try {
    const submitted = await runMcp(
      { DSH_BRIDGE_URL: first.url },
      [
        mcpInit(1),
        mcpCall(2, 'dsh_task', { instruction: '重启前完成', cwd: 'E:/tmp/e2e-restart', originThreadId: 'origin-R', wait: false }),
        mcpCall(3, 'dsh_task', { instruction: '重启前没跑完', cwd: 'E:/tmp/e2e-restart2', originThreadId: 'origin-R', wait: false }),
      ],
    )
    const p2 = payloadOf(submitted.get(2))
    const p3 = payloadOf(submitted.get(3))
    const doneId = p2 !== null && typeof p2 === 'object' ? p2.taskId : undefined
    const pendingId = p3 !== null && typeof p3 === 'object' ? p3.taskId : undefined
    // 诊断：一旦有拒绝/持久错误，这里会直接给出两条任务的 payload 与磁盘记录（含 reason/error）
    const diagnostics = () => JSON.stringify({
      p2, p3,
      starts: first.starts.length,
      children: first.childMarkers(),
      record2: doneId === undefined ? null : openAssociations({ root: assocRoot }).record(doneId),
      record3: pendingId === undefined ? null : openAssociations({ root: assocRoot }).record(pendingId),
    })
    // 两路派活都必须真的提交成功（ok/origin/taskId），而不是 accepted-but-unbound 或被拒绝。
    // 诊断只在失败路径构造（避免通过时也去读盘）。
    const submittedOk = p2 !== null && typeof p2 === 'object' && p2.ok === true
      && p3 !== null && typeof p3 === 'object' && p3.ok === true
      && p2.originThreadId === 'origin-R' && p3.originThreadId === 'origin-R'
      && typeof doneId === 'string' && doneId !== ''
      && typeof pendingId === 'string' && pendingId !== ''
    if (!submittedOk) assert.fail('两路派活必须真的提交成功（ok/origin/taskId）: ' + diagnostics())
    // **有上限地**等两个 worker 都真正注册再结清（202 只表示已接受；超时给出完整诊断）
    const startedDone = await first.waitForChild('重启前完成', { timeoutMs: 5000 })
    const startedPending = await first.waitForChild('重启前没跑完', { timeoutMs: 5000 })
    if (!startedDone || !startedPending) assert.fail('两个 worker 必须在时限内真正启动: ' + diagnostics())
    if (first.complete('重启前完成', '重启前的结果') !== true) assert.fail('complete 必须找到第 1 个 worker: ' + diagnostics())
    await tick(60)
    if (first.starts.length !== 2) assert.fail('两条派活都应各启动一次: ' + diagnostics())
    await first.close()

    // 新实例：同一持久 root，全新内存表、全新端口
    second = await startGateway({ assocRoot })
    const turn = await runMcp(
      { DSH_BRIDGE_URL: second.url },
      [
        mcpInit(1),
        mcpCall(2, 'dsh_task_status', { taskId: doneId, originThreadId: 'origin-R' }),
        mcpCall(3, 'dsh_task_status', { taskId: pendingId, originThreadId: 'origin-R' }),
        mcpCall(4, 'dsh_task_status', { taskId: doneId }),
      ],
    )
    const recovered = payloadOf(turn.get(2))
    assert.equal(recovered.status, 'done')
    assert.equal(recovered.result, '重启前的结果')
    assert.equal(recovered.recovered, true)

    const unconfirmed = payloadOf(turn.get(3))
    assert.equal(unconfirmed.status, 'unknown', '未完成任务不得谎报完成')
    assert.equal(unconfirmed.resend, false, '必须明确不要重发')
    assert.equal(unconfirmed.reason, 'execution-state-unconfirmed')
    assert.deepEqual(unconfirmed.target, { kind: 'worker', cwd: 'E:\\tmp\\e2e-restart2', lane: 'main' })

    const noOrigin = payloadOf(turn.get(4))
    assert.equal(noOrigin.reason, 'origin-required', '缺来源时如实拒绝，不猜')

    assert.equal(second.starts.length, 0, '恢复路径绝不启动新执行')
    assert.equal(second.prompts.length, 0)
  } finally {
    await first.close()
    if (second !== undefined) await second.close()
  }
})

test('端到端（CLI×2 进程）：--origin 派活 → 新进程按来源找回并取值；无来源时如实拒绝；CODEX_THREAD_ID 兜底', async () => {
  const assocRoot = await makeTmp('dsh-e2e-cli-')
  const historyDir = await makeTmp('dsh-e2e-hist-')
  const gateway = await startGateway({ assocRoot })
  const env = { DSH_BRIDGE_URL: gateway.url, DSH_BRIDGE_HISTORY: path.join(historyDir, 'history.ndjson') }
  try {
    // 回合 1：显式 --origin 派活（不等待）
    const dispatched = await runCli(['--in', 'CLI 派活', '--cwd', 'E:/tmp/e2e-cli', '--no-wait', '--origin', 'origin-CLI'], env)
    assert.equal(dispatched.status, 0, dispatched.stderr)
    const submitted = JSON.parse(dispatched.stdout.trim().split('\n').pop())
    assert.equal(submitted.originThreadId, 'origin-CLI')
    assert.match(dispatched.stderr, /来源关联 originThreadId=origin-CLI/)
    assert.equal(typeof submitted.taskId === 'string' && submitted.taskId !== '', true, '必须返回 taskId: ' + JSON.stringify(submitted))
    const taskId = submitted.taskId

    // 有上限地等 worker 真正注册（--no-wait 的 202 只表示已接受），再结清
    assert.equal(await gateway.waitForChild('CLI 派活', { timeoutMs: 5000 }), true,
      'worker 必须在时限内真正启动: ' + JSON.stringify({ payload: submitted, starts: gateway.starts.length, children: gateway.childMarkers() }))
    assert.equal(gateway.complete('CLI 派活', 'CLI 任务结果'), true)
    await tick()

    // 回合 2：全新 CLI 进程，只给来源 → 找到 taskId；再按 origin+taskId 取结果
    const mine = await runCli(['--my-tasks', '--origin', 'origin-CLI'], env)
    assert.equal(mine.status, 0, mine.stderr)
    assert.deepEqual(JSON.parse(mine.stdout).tasks.map((t) => t.taskId), [taskId])

    const exact = await runCli(['--status', taskId, '--origin', 'origin-CLI'], env)
    assert.equal(exact.status, 0, exact.stderr)
    assert.equal(JSON.parse(exact.stdout).result, 'CLI 任务结果')

    // 缺来源：不得读到已关联结果
    const missing = await runCli(['--status', taskId], { ...env, CODEX_THREAD_ID: '' })
    assert.equal(missing.status, 6)
    assert.equal(JSON.parse(missing.stdout).reason, 'origin-required')

    // 错来源：非零退出且不返回结果
    const wrong = await runCli(['--status', taskId, '--origin', 'origin-OTHER'], env)
    assert.equal(wrong.status, 6)
    assert.equal(JSON.parse(wrong.stdout).reason, 'origin-mismatch')

    // 无来源（既没 --origin 也没 CODEX_THREAD_ID）→ 如实拒绝来源模式
    const noOriginEnv = { ...env, CODEX_THREAD_ID: '' }
    const refused = await runCli(['--my-tasks'], noOriginEnv)
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /需要来源对话 id/)

    // --require-origin 且无来源 → 拒绝派活（不降级成无关联）
    const startsBefore = gateway.starts.length
    const requireRefused = await runCli(['--in', '不该派出去', '--cwd', 'E:/tmp/e2e-cli2', '--no-wait', '--require-origin'], noOriginEnv)
    assert.equal(requireRefused.status, 2)
    assert.match(requireRefused.stderr, /--require-origin/)
    assert.equal(gateway.starts.length, startsBefore, '拒绝时必须零派活')

    // CODEX_THREAD_ID 兜底（CLI 每次独立进程，这个环境变量就是本次调用的上下文）
    const viaEnv = await runCli(['--in', '环境来源派活', '--cwd', 'E:/tmp/e2e-cli3', '--no-wait'], { ...env, CODEX_THREAD_ID: 'origin-ENV' })
    assert.equal(viaEnv.status, 0, viaEnv.stderr)
    assert.equal(JSON.parse(viaEnv.stdout.trim().split('\n').pop()).originThreadId, 'origin-ENV')
    assert.match(viaEnv.stderr, /来源关联 originThreadId=origin-ENV（CODEX_THREAD_ID）/)

    // 旧的无来源调用仍然兼容
    const legacy = await runCli(['--in', '无来源的旧调用', '--cwd', 'E:/tmp/e2e-cli4', '--no-wait'], noOriginEnv)
    assert.equal(legacy.status, 0, legacy.stderr)
    assert.equal(JSON.parse(legacy.stdout.trim().split('\n').pop()).originThreadId, undefined)

    // 严格参数：--origin 缺值 → 用法错误
    const missingValue = await runCli(['--my-tasks', '--origin'], env)
    assert.equal(missingValue.status, 2)
    assert.match(missingValue.stderr, /--origin 需要一个值/)
  } finally {
    await gateway.close()
  }
})
