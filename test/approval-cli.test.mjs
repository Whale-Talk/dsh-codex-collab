/**
 * 第四轮 CLI 入口回归（真实 CLI 进程 + 真实 HTTP 网关 + 自建 key）：
 *  1) 委托派活 `--delegate --no-wait` 必须带认证头 → 202 + 单 prompt/单 grant；缺 key 仍预检零派活；
 *  2) **初次默认等待**（不是二次 --status-wait）跨过 2s 短租约遇到真实 pending → exit 9 且随后可答；
 *  3) 同一次初次等待精确取回自己那条任务的 completed 结果；
 *  4) 错来源 echo 绝不透出 result。
 *
 * 跑法: node test/approval-cli.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, runCli } from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-cli-key-'))
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

const lastJson = (stdout) => {
  const lines = stdout.trim().split('\n').filter((line) => line.startsWith('{'))
  return lines.length === 0 ? null : JSON.parse(lines[lines.length - 1])
}

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

const setup = async () => {
  const assocRoot = await makeTmp('approval-cli-assoc-')
  const storeRoot = await makeTmp('approval-cli-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot } })
  const rows = (name) => {
    try { return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch (e) { return [] }
  }
  const cliEnv = { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }
  const taskIdForOrigin = async (origin) => {
    for (let i = 0; i < 200; i++) {
      const res = await getJson(gateway.url + '/api/dsh-bridge/status?originThreadId=' + encodeURIComponent(origin))
      const list = res.body !== null && typeof res.body === 'object' && Array.isArray(res.body.tasks) ? res.body.tasks : []
      if (list.length > 0 && typeof list[0].taskId === 'string') return list[0].taskId
      await sleep(20)
    }
    return null
  }
  return {
    gateway, events, storeRoot, cliEnv, taskIdForOrigin,
    grantRows: () => rows('grants.jsonl').filter((r) => r.type === 'grant'),
    leaseUpdates: () => rows('grants.jsonl').filter((r) => r.type === 'grant-update'),
  }
}

const snapshotReal = (gateway, sessionId, callId, name, args, cwd = 'E:/work') =>
  gateway.emitCtx('tools/pre-execute', {
    agent: { session: { id: sessionId, header: { id: sessionId, cwd } } },
    callId, rootCallId: callId, name, arguments: args,
  }, () => ({ kind: 'allow' }))

const ask = (gateway, sessionId, toolName, callId) => {
  const state = { humanNext: 0 }
  const results = gateway.emitCtx('approval/request', {
    agent: { session: { id: sessionId } }, toolName, callId, reason: 'fixture',
  }, () => { state.humanNext += 1; return Promise.resolve('rejected') })
  return { promise: results[0], state }
}

// ---------------------------------------------------------------- 1) 委托派活带认证

test('CLI 委托派活带认证头：--delegate --no-wait → 202 + 单 prompt/单 grant + grantId 回显；缺 key 零派活', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'root-cli-origin'
  const sessionId = 'root-cli-session'
  try {
    const delegated = await runCli(['--in', 'CLI 委托派活 fixture', '--session', sessionId, '--origin', origin, '--delegate', '--no-wait'], env.cliEnv)
    assert.equal(delegated.status, 0, 'CLI 委托派活必须成功（之前漏认证头会 exit1 approval-control-invalid）: ' + delegated.stderr)
    const payload = JSON.parse(delegated.stdout)
    assert.equal(typeof payload.taskId, 'string', 'stdout 应回显 taskId')
    assert.equal(typeof payload.grantId, 'string', 'stdout 应回显非秘密 grantId: ' + delegated.stdout)
    assert.equal(payload.originThreadId, origin)
    assert.equal(gateway.prompts.length, 1, '只允许一次 prompt')
    assert.equal(env.grantRows().length, 1, '只签发一个 grant')
    assert.equal(delegated.stdout.includes(RAW_KEY), false, 'stdout 不得出现 raw key')
    assert.equal(delegated.stderr.includes(RAW_KEY), false, 'stderr 不得出现 raw key')

    // 缺 key：预检拒绝且零派活
    const noKey = await runCli(['--in', '不该出去', '--session', sessionId, '--origin', origin, '--delegate', '--no-wait'], { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: path.join(keyDir, 'missing.key') })
    assert.equal(noKey.status, 2, '缺 key 必须用法错误退出: ' + noKey.stderr)
    assert.equal(gateway.prompts.length, 1, '缺 key 不得发出任何 prompt')
    assert.equal(env.grantRows().length, 1, '缺 key 不得签发 grant')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 2) 初次默认等待跨短租约

test('CLI 初次默认等待跨 2s 短租约：慢 ask 到达时 exit 9，且 pending 仍可答（无需二次 --status-wait）', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'root-cli-origin-wait'
  const sessionId = 'root-cli-session-wait'
  try {
    // 慢模型：4.2s 后才发第一个 ask（初始租约只有 2s）
    const slow = (async () => {
      const taskId = await env.taskIdForOrigin(origin)
      assert.notEqual(taskId, null, '需要拿到 taskId 才能驱动慢 ask')
      await sleep(4200)
      let seq = events.length
      events.push(
        ev(++seq, 'turn/start', { turn: 1 }),
        ev(++seq, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
        ev(++seq, 'tool/call', { turn: 1, step: 1, callId: 'cli-slow-1', name: 'pwsh', arguments: '{}' }),
        ev(++seq, 'approval/asked', { id: 'off-cli-slow', toolName: 'pwsh', callId: 'cli-slow-1' }),
      )
      snapshotReal(gateway, sessionId, 'cli-slow-1', 'pwsh', { command: 'cli-slow-sentinel' })
      return { held: ask(gateway, sessionId, 'pwsh', 'cli-slow-1'), taskId }
    })()

    // 初次路径：默认 wait（不传 --no-wait），**不预查 grant、不调用二次 --status-wait**
    const cli = await runCli(['--in', 'CLI 初次等待短租约', '--session', sessionId, '--origin', origin, '--delegate', '--delegate-lease', '2', '--timeout', '40'], env.cliEnv)
    const { held, taskId } = await slow
    assert.equal(cli.status, 9, '慢 ask 到达时初次等待必须 exit 9（非终态）: stdout=' + cli.stdout.slice(0, 200) + ' stderr=' + cli.stderr.slice(0, 300))
    const payload = lastJson(cli.stdout)
    assert.notEqual(payload, null, 'stdout 应含 JSON 行')
    assert.equal(payload.phase, 'needs-approval')
    assert.equal(payload.needsApproval, true)
    assert.equal(held.state.humanNext, 0, '不得交还人工（说明初次等待期间认证续租保住了可答状态）')
    // 认证续租确实发生在**初次等待路径**上（可数持久证据）
    assert.equal(env.leaseUpdates().length >= 2, true, '初次等待必须发生多次认证续租，实测 ' + env.leaseUpdates().length)
    assert.equal(gateway.prompts.length, 1, '不得额外派活')
    assert.equal(env.grantRows().length, 1, '不得额外签发 grant')
    // 该 pending 仍然可答（认证 list 顺带续租后立即决定）
    const listed = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId), HEADERS)
    const pending = listed.body.approvals.find((p) => p.callId === 'cli-slow-1')
    assert.notEqual(pending, undefined, '必须有可答 pending: ' + JSON.stringify(listed.body.approvals.map((p) => [p.callId, p.state])))
    const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + pending.approvalKey + '/decide', {
      originThreadId: origin, taskId, grantId: pending.grantId, fingerprint: pending.fingerprint, decision: 'approve-once',
    }, HEADERS)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(await held.promise, 'allowed-once')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 3) 初次等待取回结果

test('CLI 初次默认等待精确取回同一任务的 completed 结果', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'root-cli-origin-done'
  const sessionId = 'root-cli-session-done'
  try {
    const finish = (async () => {
      const taskId = await env.taskIdForOrigin(origin)
      assert.notEqual(taskId, null)
      await sleep(600)
      let seq = events.length
      events.push(
        ev(++seq, 'turn/start', { turn: 1 }),
        ev(++seq, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
        ev(++seq, 'assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'CLI EXACT RESULT SENTINEL' }] } }),
        ev(++seq, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      )
      gateway.emitCtx('api-session/status', sessionId, true)
      gateway.emitCtx('api-session/status', sessionId, false)
      return taskId
    })()

    const cli = await runCli(['--in', 'CLI 取回结果', '--session', sessionId, '--origin', origin, '--timeout', '40'], env.cliEnv)
    const taskId = await finish
    assert.equal(cli.status, 0, 'completed → exit 0: stdout=' + cli.stdout.slice(0, 300) + ' stderr=' + cli.stderr.slice(0, 300))
    assert.equal(cli.stdout.includes('CLI EXACT RESULT SENTINEL'), true, '必须精确取回自己那条任务的结果: ' + cli.stdout.slice(0, 300))
    const finished = lastJson(cli.stdout)
    assert.notEqual(finished, null)
    assert.equal(finished.phase, 'finished')
    assert.equal(finished.taskId, taskId, '必须是同一个任务')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 4) 错来源不透结果

test('CLI 错来源 echo 绝不透出 result', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'root-cli-origin-leak'
  const sessionId = 'root-cli-session-leak'
  try {
    const dispatched = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', sessionId, originThreadId: origin, deliver: 'queue' })
    assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body))
    const taskId = dispatched.body.taskId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'LEAK SENTINEL' }] } }),
      ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )
    gateway.emitCtx('api-session/status', sessionId, true)
    gateway.emitCtx('api-session/status', sessionId, false)
    await sleep(300)
    const cli = await runCli(['--status', taskId, '--origin', 'some-other-origin', '--status-wait', '--timeout', '10'], env.cliEnv)
    assert.equal(cli.stdout.includes('LEAK SENTINEL'), false, '错来源绝不透出 result: ' + cli.stdout.slice(0, 300))
    assert.equal([6, 8].includes(cli.status), true, '错来源应明确失败（6=拒绝/8=未确认），实测 ' + cli.status + ' stderr=' + cli.stderr.slice(0, 200))
  } finally {
    await gateway.close()
  }
})
