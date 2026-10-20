/**
 * 审批委托加固回归（对应 root 独立探测 A/B/F/G 发现的失败）：
 *   A1 跨会话参数替换：另一**未委托**会话用同 callId 的 pre-execute 绝不能改写本会话待审视图；
 *   A2 同会话上下文变更：同一 (session, callId) 重新 pre-execute（参数变）→ 决定被拒 + 等待方交还人工；
 *   B1 同一 callId 两次官方 ask → 两条独立 pending、两次独立决定（绝不被一次决定放行两条）；
 *   F1 官方 decided=cancelled → 绝不是 confirmed（哪怕我们已提交过 allowed-once）；
 *   G1 dsh_task_status(wait) 的后续轮询必须核对来源回显：错来源不透 result。
 *
 * 全部独立临时 root + 自建 key。跑法: node test/approval-hardening.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, runMcp, mcpInit, mcpCall, payloadOf } from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-hardening-key-'))
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

const setup = async () => {
  const assocRoot = await makeTmp('approval-hard-assoc-')
  const storeRoot = await makeTmp('approval-hard-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot } })
  const readJsonl = (name) => {
    try { return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch (e) { return [] }
  }
  return { gateway, events, storeRoot, grantRows: () => readJsonl('grants.jsonl').filter((r) => r.type === 'grant'), auditRows: () => readJsonl('audit.jsonl') }
}

const dispatchDelegate = (gateway, origin, sessionId, extra = {}) =>
  postJson(gateway.url + '/api/dsh-bridge/task', { instruction: '加固回归任务', sessionId, deliver: 'queue', originThreadId: origin, delegate: true, ...extra }, HEADERS)

const snapshot = (gateway, sessionId, callId, name, args, cwd) =>
  gateway.emitCtx('tools/pre-execute', { agent: { session: { id: sessionId }, cwd }, callId, rootCallId: callId, name, arguments: args, cwd }, () => ({ kind: 'allow' }))

const ask = (gateway, sessionId, toolName, callId) => {
  const state = { humanNext: 0 }
  const results = gateway.emitCtx('approval/request', {
    agent: { session: { id: sessionId } }, toolName, callId,
    reason: 'escalate sandbox to workspace-write: fixture',
  }, () => { state.humanNext += 1; return Promise.resolve('rejected') })
  return { promise: results[0], state }
}

const listUrl = (gateway, origin, taskId, extra = '') => gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId) + extra

test('A1: 另一未委托会话用同 callId 的 pre-execute 绝不能改写本会话的待审视图', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-cross'
  const sessionId = 'sess-cross-A'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'shared-1', name: 'bash', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'off-cross', toolName: 'bash', callId: 'shared-1' }),
    )
    // A 会话：危险哨兵参数
    snapshot(gateway, sessionId, 'shared-1', 'bash', { command: 'rm -rf /danger-sentinel' }, 'E:/a')
    const held = ask(gateway, sessionId, 'bash', 'shared-1')
    const seen = await until(async () => {
      const res = await getJson(listUrl(gateway, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.length > 0 ? res : false
    })
    assert.notEqual(seen, false, 'A 会话应真正挂起')
    const key = seen.body.approvals[0].approvalKey
    const fingerprint = seen.body.approvals[0].fingerprint
    assert.equal(seen.body.approvals[0].args.command, 'rm -rf /danger-sentinel')

    // 另一会话（未委托）复用同一个 callId 做 pre-execute：安全哨兵参数
    snapshot(gateway, 'sess-cross-B', 'shared-1', 'bash', { command: 'echo safe-sentinel' }, 'E:/b')
    const viewAfter = await getJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + taskId, HEADERS)
    assert.equal(viewAfter.body.approval.args.command, 'rm -rf /danger-sentinel', 'B 会话的快照不得替换 A 的待审视图')
    assert.equal(viewAfter.body.approval.fingerprint, fingerprint, '指纹必须仍绑定 A 的不可变执行')
    assert.equal(viewAfter.body.approval.cwd, 'E:/a')
    assert.equal(JSON.stringify(viewAfter.body).includes('safe-sentinel'), false, 'B 的安全参数不得出现在 A 的详情里')

    // 未委托会话 B 的 ask 必须交还人工
    const bAsk = ask(gateway, 'sess-cross-B', 'bash', 'shared-1')
    assert.equal(await bAsk.promise, 'rejected')
    assert.equal(bAsk.state.humanNext, 1)

    // A 仍可用自己的指纹决定（且只有 A 的那个 callback 得到 allowed-once）
    const decide = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '/decide', { originThreadId: origin, taskId, grantId, fingerprint, decision: 'approve-once' }, HEADERS)
    assert.equal(decide.status, 200, JSON.stringify(decide.body))
    assert.equal(await held.promise, 'allowed-once')
    assert.equal(held.state.humanNext, 0)
  } finally {
    await gateway.close()
  }
})

test('A2: 同会话同 callId 重新 pre-execute（参数变）→ 等待方交还人工、决定被拒', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-ctx'
  const sessionId = 'sess-ctx'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'ctx-1', name: 'bash', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'off-ctx', toolName: 'bash', callId: 'ctx-1' }),
    )
    snapshot(gateway, sessionId, 'ctx-1', 'bash', { command: 'cp a b' }, 'E:/w')
    const held = ask(gateway, sessionId, 'bash', 'ctx-1')
    const seen = await until(async () => {
      const res = await getJson(listUrl(gateway, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.length > 0 ? res : false
    })
    const key = seen.body.approvals[0].approvalKey
    const fingerprint = seen.body.approvals[0].fingerprint

    // 同一 (session, callId) 换了参数（模拟 TOCTOU：真实执行被替换）
    snapshot(gateway, sessionId, 'ctx-1', 'bash', { command: 'rm -rf /changed' }, 'E:/w')
    const decide = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '/decide', { originThreadId: origin, taskId, grantId, fingerprint, decision: 'approve-once' }, HEADERS)
    assert.equal(decide.status, 409)
    assert.equal(decide.body.reason, 'approval-context-changed', '上下文变化必须拒绝')
    assert.equal(await held.promise, 'rejected', '上下文变化时等待方必须交还人工')
    assert.equal(held.state.humanNext, 1)
    assert.equal(env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted').length, 0, '拒绝路径不得产生决定审计')
  } finally {
    await gateway.close()
  }
})

test('B1: 同一 callId 两次官方 ask → 两条独立 pending，一次决定只放行一条', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-two'
  const sessionId = 'sess-two'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'twice-1', name: 'bash', arguments: '{}' }),
      // 同一次真实调用可以合法发起两次 ApprovalService.request()，官方各自一个 UUID
      ev(4, 'approval/asked', { id: 'off-two-1', toolName: 'bash', callId: 'twice-1' }),
      ev(5, 'approval/asked', { id: 'off-two-2', toolName: 'bash', callId: 'twice-1' }),
    )
    snapshot(gateway, sessionId, 'twice-1', 'bash', { command: 'ls' }, 'E:/w')
    const first = ask(gateway, sessionId, 'bash', 'twice-1')
    const second = ask(gateway, sessionId, 'bash', 'twice-1')

    // 若一次 ask 会看到两个未认领 ask（歧义）→ 两条都应交还人工，绝不猜；若按序各认领一个 → 两条 pending。
    const settled = await Promise.all([first.promise, second.promise])
    const human = first.state.humanNext + second.state.humanNext
    if (human === 0) {
      const list = await until(async () => {
        const res = await getJson(listUrl(gateway, origin, taskId), HEADERS)
        return res.body.ok === true && res.body.approvals.length >= 1 ? res : false
      })
      assert.notEqual(list, false)
      const pendingKeys = list.body.approvals.map((p) => p.approvalKey)
      assert.equal(new Set(pendingKeys).size, pendingKeys.length, 'pending 必须彼此独立')
      const target = list.body.approvals[0]
      const decide = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + target.approvalKey + '/decide', { originThreadId: origin, taskId, grantId, fingerprint: target.fingerprint, decision: 'approve-once' }, HEADERS)
      assert.equal(decide.status, 200)
      // 只有一条 callback 拿到 allowed-once；另一条必须仍未决（不可能被同一次决定放行两条）
      const approved = (await Promise.all([first.promise, second.promise])).filter((o) => o === 'allowed-once').length
      assert.equal(approved, 1, '一次决定只能放行一条官方 callback')
    } else {
      // 歧义即交人工：两条都不得被放行
      assert.deepEqual(settled, ['rejected', 'rejected'])
      const audit = env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted')
      assert.equal(audit.length, 0, '歧义路径绝不产生决定审计')
    }
  } finally {
    await gateway.close()
  }
})

test('F1: 官方 decided=cancelled 绝不算 confirmed（即便我们已提交 allowed-once）', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-cancel'
  const sessionId = 'sess-cancel'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'cancel-1', name: 'bash', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'off-cancel', toolName: 'bash', callId: 'cancel-1' }),
    )
    snapshot(gateway, sessionId, 'cancel-1', 'bash', { command: 'ls' }, 'E:/w')
    const held = ask(gateway, sessionId, 'bash', 'cancel-1')
    const seen = await until(async () => {
      const res = await getJson(listUrl(gateway, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.length > 0 ? res : false
    })
    const key = seen.body.approvals[0].approvalKey
    const fingerprint = seen.body.approvals[0].fingerprint
    const decide = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '/decide', { originThreadId: origin, taskId, grantId, fingerprint, decision: 'approve-once' }, HEADERS)
    assert.equal(decide.status, 200)
    assert.equal(await held.promise, 'allowed-once', 'SDK 侧此时得到 allowed-once（官方 decide 的返回值）')

    // 官方随后记录 cancelled（取消可赢过晚到的 allowed-once）
    events.push(ev(5, 'approval/decided', { id: 'off-cancel', outcome: 'cancelled' }))
    await gateway.runIntervals()
    const after = await getJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + taskId, HEADERS)
    assert.equal(after.body.approval.state, 'cancelled', '官方 cancelled 必须覆盖为 cancelled')
    assert.notEqual(after.body.approval.state, 'confirmed')
    assert.equal(after.body.approval.confirmedOutcome, 'cancelled')
    const phases = env.auditRows().filter((r) => r.type === 'decision').map((r) => r.phase)
    assert.equal(phases.includes('confirmed'), false, 'cancelled 绝不能记成 confirmed')
    assert.equal(phases.includes('cancelled'), true)
  } finally {
    await gateway.close()
  }
})

test('G1: dsh_task_status(wait) 的后续轮询核对来源回显；错来源不透 result', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'origin-wait'
  const sessionId = 'sess-wait'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const mcpEnv = { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }
    const wrong = await runMcp(mcpEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task_status', { taskId, originThreadId: 'origin-OTHER', wait: true, timeoutSec: 5 }),
    ], 20000)
    const payload = payloadOf(wrong.get(1))
    // 网关按 R1 契约回明确拒绝（{error, reason:origin-mismatch}）；关键是**绝不透出 result**。
    assert.equal(payload.reason, 'origin-mismatch', '错来源必须被明确拒绝: ' + JSON.stringify(payload))
    assert.equal(payload.result, undefined, '错来源绝不透出 result')
    assert.equal(JSON.stringify(payload).includes('"result"'), false)
    assert.equal(payload.ok === true, false, '错来源不得被判为成功')
  } finally {
    await gateway.close()
  }
})
