/**
 * 第二轮独立验收的三个阻塞项的**行为回归**（真实 bridge + HTTP；SDK 用 harness 镜像的真实 shape）：
 *  1) 上下文/代际变化：root-only / step-only（仅日志新 tool/call）/ tool-only / parent-only → 旧审批必须被拒；
 *     身份不完整（无 cwd 来源）→ 交还人工，绝不接手；pending 副本不被改写。
 *  2) needs-approval 必须在同会话忙锁内：第二次派活被拒且零 prompt，第一任务的 record/观察/结果不丢。
 *  3) 有效认证委托不被 quiet/total 观察预算误收口；失联/撤销/到期后仍有界安全退出；未委托保持旧语义。
 *
 * cwd 用**官方真实来源** `agent.session.header.cwd`（dsh-tools:1423；dsh-session:1044 保证绝对路径）。
 * 跑法: node test/approval-window.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway } from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-window-key-'))
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

const setup = async (env = {}) => {
  const assocRoot = await makeTmp('approval-window-assoc-')
  const storeRoot = await makeTmp('approval-window-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot, ...env } })
  const readJsonl = (name) => {
    try { return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch (e) { return [] }
  }
  return { gateway, events, storeRoot, grantRows: () => readJsonl('grants.jsonl').filter((r) => r.type === 'grant'), auditRows: () => readJsonl('audit.jsonl') }
}

const dispatchDelegate = (gateway, origin, sessionId, extra = {}) =>
  postJson(gateway.url + '/api/dsh-bridge/task', { instruction: '观察窗口回归', sessionId, deliver: 'queue', originThreadId: origin, delegate: true, ...extra }, HEADERS)

const dispatchPlain = (gateway, sessionId, instruction = '无委托任务') =>
  postJson(gateway.url + '/api/dsh-bridge/task', { instruction, sessionId, deliver: 'queue' })

/** 官方真实 shape：cwd 在 agent.session.header.cwd；可显式省略以制造"身份不完整"。 */
const snapshotReal = (gateway, sessionId, callId, name, args, cwd = 'E:/work', extra = {}) =>
  gateway.emitCtx('tools/pre-execute', {
    agent: { session: { id: sessionId, header: cwd === null ? {} : { id: sessionId, cwd } } },
    callId, rootCallId: callId, name, arguments: args, ...extra,
  }, () => ({ kind: 'allow' }))

const ask = (gateway, sessionId, toolName, callId) => {
  const state = { humanNext: 0 }
  const results = gateway.emitCtx('approval/request', {
    agent: { session: { id: sessionId } }, toolName, callId,
    reason: 'escalate sandbox to workspace-write: fixture',
  }, () => { state.humanNext += 1; return Promise.resolve('rejected') })
  return { promise: results[0], state }
}

const listUrl = (gateway, origin, taskId, extra = '') => gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId) + extra
const detailUrl = (gateway, key, origin, taskId) => gateway.url + '/api/dsh-bridge/approvals/' + key + '?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId)

/** 起一个已委托任务 + 一条已认领的 pending，返回决定所需的全部上下文。 */
const openPendingFixture = async (env, { origin, sessionId, callId = 'ctx-call', args = { command: 'sentinel-original' }, name = 'pwsh', cwd = 'E:/work' } = {}) => {
  const { gateway, events } = env
  const dispatched = await dispatchDelegate(gateway, origin, sessionId)
  assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body))
  const taskId = dispatched.body.taskId
  const grantId = env.grantRows().at(-1).grantId
  let seq = events.length
  events.push(
    ev(++seq, 'turn/start', { turn: 7 }),
    ev(++seq, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
    ev(++seq, 'tool/call', { turn: 7, step: 1, callId, name, arguments: JSON.stringify(args) }),
    ev(++seq, 'approval/asked', { id: 'off-' + callId, toolName: name, callId }),
  )
  snapshotReal(gateway, sessionId, callId, name, args, cwd)
  const held = ask(gateway, sessionId, name, callId)
  const seen = await until(async () => {
    const res = await getJson(listUrl(gateway, origin, taskId), HEADERS)
    return res.body.ok === true && res.body.approvals.some((p) => p.callId === callId) ? res : false
  })
  assert.notEqual(seen, false, 'fixture 应真正挂起: ' + callId)
  const pending = seen.body.approvals.find((p) => p.callId === callId)
  return { taskId, grantId, pending, held, events, seq }
}

const decideBody = (pending, grantId, origin, taskId, decision = 'approve-once') => ({
  originThreadId: origin, taskId, grantId, fingerprint: pending.fingerprint, decision,
})

// ---------------------------------------------------------------- 阻塞 1：代际变化

test('阻塞1: root-only / step-only / tool-only / parent-only 变化后旧审批必须被拒（且 pending 副本不被改写）', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'origin-gen'
  const sessionId = 'sess-gen'
  try {
    const cases = [
      { change: 'root-only', callId: 'ctx-root', mutate: (sid) => snapshotReal(gateway, sid, 'ctx-root', 'pwsh', { command: 'sentinel-original' }, 'E:/work', { rootCallId: 'new-parent-root' }) },
      { change: 'step-only', callId: 'ctx-step', mutate: () => env.events.push(ev(env.events.length + 1, 'tool/call', { turn: 7, step: 2, callId: 'ctx-step', name: 'pwsh', arguments: JSON.stringify({ command: 'sentinel-original' }) })) },
      { change: 'tool-only', callId: 'ctx-tool', mutate: (sid) => snapshotReal(gateway, sid, 'ctx-tool', 'different-tool', { command: 'sentinel-original' }, 'E:/work') },
      { change: 'parent-only', callId: 'ctx-parent', mutate: (sid) => snapshotReal(gateway, sid, 'ctx-parent', 'pwsh', { command: 'sentinel-original' }, 'E:/work', { parent: { token: 'parent-exec-token-2' } }) },
    ]
    for (const c of cases) {
      // 每个用例用独立会话（同一会话在途任务会被忙锁正确拒绝——那是阻塞 2 的行为）
      const caseSession = sessionId + '-' + c.change
      const fx = await openPendingFixture(env, { origin, sessionId: caseSession, callId: c.callId })
      assert.equal(fx.pending.identityComplete, true, '身份必须完整: ' + c.change)
      assert.equal(fx.pending.cwdSource, 'agent.session.header.cwd', 'cwd 必须来自官方真实来源: ' + c.change)
      c.mutate(caseSession)
      const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + fx.pending.approvalKey + '/decide', decideBody(fx.pending, fx.grantId, origin, fx.taskId), HEADERS)
      assert.equal(decided.status, 409, c.change + ' 变化后必须拒绝: ' + JSON.stringify(decided.body))
      assert.equal(decided.body.reason, 'approval-context-changed', c.change + ' 需要明确原因: ' + JSON.stringify(decided.body))
      assert.equal(await fx.held.promise, 'rejected', c.change + ' 变化后等待方必须交还人工')
      assert.equal(fx.held.state.humanNext, 1)
      // pending 副本仍展示**原始**动作（不被新上下文改写）
      const after = await getJson(detailUrl(gateway, fx.pending.approvalKey, origin, fx.taskId), HEADERS)
      assert.equal(after.body.approval.args.command, 'sentinel-original', c.change + ' 后 pending 副本必须保持原样')
      assert.equal(after.body.approval.fingerprint, fx.pending.fingerprint)
      assert.equal(after.body.approval.state, 'context-changed', c.change + ' 后的状态必须明确')
    }
    assert.equal(env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted').length, 0, '全部拒绝路径零决定审计')
  } finally {
    await gateway.close()
  }
})

test('阻塞1: 身份不完整（无任何 cwd 来源）→ 明确不支持，绝不接手（零 pending、走人工）', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-incomplete'
  const sessionId = 'sess-incomplete'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    events.push(
      ev(1, 'turn/start', { turn: 7 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 7, step: 1, callId: 'nocwd-1', name: 'pwsh', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'off-nocwd', toolName: 'pwsh', callId: 'nocwd-1' }),
    )
    snapshotReal(gateway, sessionId, 'nocwd-1', 'pwsh', { command: 'x' }, null)   // 无 cwd 来源
    const held = ask(gateway, sessionId, 'pwsh', 'nocwd-1')
    assert.equal(await held.promise, 'rejected', '身份不完整必须交还人工')
    assert.equal(held.state.humanNext, 1)
    const list = await getJson(listUrl(gateway, origin, taskId), HEADERS)
    assert.equal(list.body.approvals.length, 0, '身份不完整不得产生可批准的 pending')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 阻塞 2：忙锁

test('阻塞2/投递控制: needs-approval 属于在途 → 旧无来源路径仍拒（零 prompt）；来源绑定 queue 改为排队接收，第一任务不丢', async () => {
  const env = await setup()
  const { gateway } = env
  const origin = 'origin-busy'
  const sessionId = 'sess-busy'
  try {
    const fx = await openPendingFixture(env, { origin, sessionId, callId: 'busy-1' })
    assert.equal(gateway.prompts.length, 1, '第一任务已投递')
    const status = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(fx.taskId) + '&originThreadId=' + encodeURIComponent(origin))
    assert.equal(status.body.status, 'needs-approval')

    // 第四轮契约变更：**来源绑定**的第二次派活现在被可靠接收（排队），不再 session-busy；
    // 但旧无来源（legacy，不可精确关联）路径的忙锁必须保持。
    const second = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(second.status, 202, '来源绑定的忙时 queue 必须被接收（投递控制 D1）: ' + JSON.stringify(second.body))
    assert.equal(second.body.status, 'queued', '还没轮到它 → queued（不是 running）')
    assert.notEqual(second.body.taskId, fx.taskId, '必须是独立 taskId，不覆盖第一任务')
    assert.equal(gateway.prompts.length, 2, '排队任务可以投递（官方 FIFO 决定执行顺序）')
    assert.equal(gateway.starts.length, 0)
    assert.equal(env.grantRows().length, 2, '两个任务各自独立 grant')
    // 旧无来源路径的忙锁保持（零 prompt）
    const legacy = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'legacy', sessionId, deliver: 'queue' })
    assert.equal(legacy.status, 400)
    assert.equal(legacy.body.reason, 'session-busy')
    assert.equal(gateway.prompts.length, 2, '被拒的 legacy 派活不得发出 prompt')

    // 第一任务的原 record/观察/结果不丢：pending 仍可决定、仍可收结果，且排队任务不参与审批归属
    const list = await getJson(listUrl(gateway, origin, fx.taskId), HEADERS)
    assert.equal(list.body.approvals.length, 1, '第一任务的 pending 必须仍在')
    const secondList = await getJson(listUrl(gateway, origin, second.body.taskId), HEADERS)
    assert.equal(secondList.body.approvals.length, 0, '排队中的任务不得借同会话的 ask 拿到 pending')
    const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + fx.pending.approvalKey + '/decide', decideBody(fx.pending, fx.grantId, origin, fx.taskId), HEADERS)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(await fx.held.promise, 'allowed-once', '第一任务自己的 callback 仍能拿到 allowed-once')
    assert.equal(fx.held.state.humanNext, 0)
    const after = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(fx.taskId) + '&originThreadId=' + encodeURIComponent(origin))
    assert.equal(after.body.status, 'running', '决定后回到 running（观察未被覆盖）')
    const afterSecond = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(second.body.taskId) + '&originThreadId=' + encodeURIComponent(origin))
    assert.equal(afterSecond.body.status, 'queued', '排队任务仍保持 queued（绝不被带成 running/done）')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- 阻塞 3：观察窗口

test('阻塞3: 有效认证委托不被 quiet/total 预算误收口；撤销后有界退出；未委托保持旧语义', async () => {
  const env = await setup({ DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS: '50', DSH_BRIDGE_SESSION_QUIET_TIMEOUT_MS: '50' })
  const { gateway } = env
  const origin = 'origin-window'
  const sessionId = 'sess-window'
  try {
    const fx = await openPendingFixture(env, { origin, sessionId, callId: 'win-1' })
    await gateway.runIntervals()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await gateway.runIntervals()
    const status = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(fx.taskId) + '&originThreadId=' + encodeURIComponent(origin))
    assert.equal(status.body.status, 'needs-approval', '有效委托下 50ms 预算不得把任务收成 unknown')
    const list = await getJson(listUrl(gateway, origin, fx.taskId), HEADERS)
    assert.equal(list.body.approvals[0].state, 'pending', '有效委托下 pending 不得被判 superseded')
    assert.equal(list.body.approvals[0].grantId, fx.grantId)
    // 仍然可决定（观察窗口没有被误关）
    const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + fx.pending.approvalKey + '/decide', decideBody(fx.pending, fx.grantId, origin, fx.taskId), HEADERS)
    assert.equal(decided.status, 200, '有效委托下仍可决定: ' + JSON.stringify(decided.body))
    assert.equal(await fx.held.promise, 'allowed-once')
  } finally {
    await gateway.close()
  }
})

test('阻塞3: 撤销/失联后仍有界安全退出（交还人工，不明假成功）', async () => {
  const env = await setup({ DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS: '50', DSH_BRIDGE_SESSION_QUIET_TIMEOUT_MS: '50' })
  const { gateway } = env
  const origin = 'origin-window2'
  const sessionId = 'sess-window2'
  try {
    const fx = await openPendingFixture(env, { origin, sessionId, callId: 'win-2' })
    const revoke = await postJson(gateway.url + '/api/dsh-bridge/approvals/grants/' + encodeURIComponent(fx.grantId) + '/revoke', { originThreadId: origin, taskId: fx.taskId, grantId: fx.grantId, reason: 'window regression' }, HEADERS)
    assert.equal(revoke.status, 200)
    assert.equal(await fx.held.promise, 'rejected', '撤销后在途等待必须交还人工')
    await gateway.runIntervals()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await gateway.runIntervals()
    const status = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(fx.taskId) + '&originThreadId=' + encodeURIComponent(origin))
    assert.equal(status.body.status, 'unknown', '委托失效 + 50ms 预算 → 有界收口为未确认')
    assert.equal(status.body.resend, false, '收口必须明确"不要重发"')
    assert.equal(env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted').length, 0, '失效路径零决定审计')
  } finally {
    await gateway.close()
  }
})

test('阻塞3: 未委托任务保持旧的 quiet/total 语义', async () => {
  const env = await setup({ DSH_BRIDGE_SESSION_TOTAL_TIMEOUT_MS: '50' })
  const { gateway, events } = env
  const sessionId = 'sess-plain'
  try {
    const dispatched = await dispatchPlain(gateway, sessionId)
    assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body))
    const taskId = dispatched.body.taskId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
    )
    await gateway.runIntervals()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await gateway.runIntervals()
    const res = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId))
    assert.notEqual(res.body.status, 'needs-approval', '未委托任务不应进入审批态')
    assert.equal(['error', 'unknown'].includes(res.body.status), true, '未委托任务按旧预算有界收口（不被委托窗口豁免）: ' + res.body.status)
  } finally {
    await gateway.close()
  }
})
