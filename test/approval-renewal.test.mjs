/**
 * 第三轮收尾回归（真实 HTTP + 独立 MCP 进程）：
 *  A) 委托派活响应必须带**非秘密** grant 定位/期限；MCP 默认 wait=true 在**不手动查 grant**的前提下
 *     跨过初始短租约做认证续租，首个慢 ask 仍落在可答 pending 上（不交还人工、不额外派活）。
 *  B) 活跃 pending 不得同时出现在 approvals(live:true) 与 unanswerable（重启残留）；重启后仍需恢复
 *     submitted→decision-unknown、未决定→unanswerable。
 *  C) reject 的文案不得诱导去等 confirmed（官方 reject 终态是 rejected）。
 *
 * 跑法: node test/approval-renewal.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, runMcp, mcpInit, mcpCall, payloadOf } from './helpers/dsh-host.mjs'
import { APPROVAL_STATES, controlCredDigest, initControlKey, openApprovalStore } from '../harness/codex-approvals.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-renewal-key-'))
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const setup = async () => {
  const assocRoot = await makeTmp('approval-renew-assoc-')
  const storeRoot = await makeTmp('approval-renew-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot } })
  const rows = (name) => {
    try { return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch (e) { return [] }
  }
  return {
    gateway, events, storeRoot,
    grantRows: () => rows('grants.jsonl').filter((r) => r.type === 'grant'),
    leaseUpdates: () => rows('grants.jsonl').filter((r) => r.type === 'grant-update'),
    auditRows: () => rows('audit.jsonl'),
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

// ---------------------------------------------------------------- A) grant 定位/期限

test('A: 委托派活响应带非秘密 grant 定位/期限；status 每次刷新当前租约；未委托任务不带', async () => {
  const env = await setup()
  const { gateway } = env
  try {
    const dispatched = await postJson(gateway.url + '/api/dsh-bridge/task', {
      instruction: 'grant 回显回归', sessionId: 'sess-grant', deliver: 'queue',
      originThreadId: 'origin-grant', delegate: true, delegateLeaseSec: 5, authorization: '仅测试授权',
    }, HEADERS)
    assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body))
    assert.equal(typeof dispatched.body.grantId, 'string', '派活响应必须带 grantId（第三轮修正 A）: ' + JSON.stringify(dispatched.body))
    assert.match(dispatched.body.grantId, /^grt-/)
    assert.equal(Number.isFinite(dispatched.body.grantExpiresAt), true)
    assert.equal(Number.isFinite(dispatched.body.grantLeaseUntil), true)
    assert.equal(JSON.stringify(dispatched.body).includes(RAW_KEY), false, '响应里不得出现 raw key')
    // 状态响应同样给出当前视图（等待循环据此自适应续租）
    const status = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(dispatched.body.taskId) + '&originThreadId=origin-grant')
    assert.equal(status.body.grantId, dispatched.body.grantId)
    assert.equal(Number.isFinite(status.body.grantLeaseUntil), true)
    // 旧兼容：未委托任务不带任何 grant 字段
    const plain = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: '无委托', cwd: 'E:/tmp/plain-renew' })
    assert.equal(plain.status, 202)
    assert.equal(plain.body.grantId, undefined)
    assert.equal(plain.body.grantLeaseUntil, undefined)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- A) 默认路径跨初始短租约

test('A: MCP 默认 wait=true（不传 grantId）跨过 2s 初始短租约：认证续租发生、慢 ask 仍可答、不额外派活', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-slow'
  const sessionId = 'sess-slow'
  const taskIdHolder = { value: null }
  try {
    // 慢模型：4.5s 之后才发第一个 ask（是初始 2s 租约的 2 倍多）
    const slow = (async () => {
      await sleep(4500)
      // 这里才知道 taskId：从关联/网关状态里读（不是手动查 grant）
      const listed = await getJson(gateway.url + '/api/dsh-bridge/status?originThreadId=' + encodeURIComponent(origin))
      const taskId = Array.isArray(listed.body.tasks) && listed.body.tasks.length > 0 ? listed.body.tasks[0].taskId : null
      assert.notEqual(taskId, null, '慢 ask 需要拿到 taskId')
      taskIdHolder.value = taskId
      let seq = events.length
      events.push(
        ev(++seq, 'turn/start', { turn: 1 }),
        ev(++seq, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
        ev(++seq, 'tool/call', { turn: 1, step: 1, callId: 'slow-1', name: 'pwsh', arguments: '{}' }),
        ev(++seq, 'approval/asked', { id: 'off-slow', toolName: 'pwsh', callId: 'slow-1' }),
      )
      snapshotReal(gateway, sessionId, 'slow-1', 'pwsh', { command: 'slow-sentinel' })
      return ask(gateway, sessionId, 'pwsh', 'slow-1')
    })()

    // 默认路径：只给 delegate + wait=true，**不传 grantId**（MCP 必须自己从派活响应/状态里拿）
    const round = await runMcp({ DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', {
        instruction: '慢模型续租回归', sessionId, originThreadId: origin, delegate: true,
        delegateLeaseSec: 2, wait: true, timeoutSec: 30, authorization: '仅测试授权',
      }),
    ], 40000)
    const payload = payloadOf(round.get(1))
    const held = await slow

    // 首个 ask 仍落在可答 pending 上（没被初始租约交还人工）
    assert.equal(payload.status, 'needs-approval', '慢 ask 必须仍是可答的 needs-approval: ' + JSON.stringify(payload))
    assert.equal(payload.needsApproval, true)
    assert.equal(typeof payload.grantId, 'string', 'MCP 返回里应带 grantId（来自派活/状态响应，非调用方传入）')
    assert.equal(held.state.humanNext, 0, '不得交还人工')
    // 认证续租确实发生（可数的持久证据）：租约被续了不止一次，且已越过 issuedAt+2000
    const updates = env.leaseUpdates()
    assert.equal(updates.length >= 2, true, '默认等待路径必须发生多次认证续租，实测 ' + updates.length + ' 次')
    const grants = env.grantRows()
    assert.equal(grants.length, 1, '不得额外派活/重复签发 grant')
    assert.equal(gateway.prompts.length, 1, '不得额外派活（prompt 只能一次）')
    assert.equal(updates.at(-1).leaseUntil > grants[0].issuedAt + 2000, true, '租约必须被延长到初始短租约之外')
    // 仍可决定
    const list = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskIdHolder.value), HEADERS)
    const pending = list.body.approvals.find((p) => p.callId === 'slow-1')
    assert.notEqual(pending, undefined, '必须有可答 pending')
    const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + pending.approvalKey + '/decide', {
      originThreadId: origin, taskId: taskIdHolder.value, grantId: pending.grantId, fingerprint: pending.fingerprint, decision: 'approve-once',
    }, HEADERS)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(await held.promise, 'allowed-once')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- B) 活跃审批不重复

test('B: 活跃 pending 只出现在 approvals(live:true)，绝不重复列进 unanswerable', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-dup'
  const sessionId = 'sess-dup'
  try {
    const dispatched = await postJson(gateway.url + '/api/dsh-bridge/task', {
      instruction: '重复上报回归', sessionId, deliver: 'queue', originThreadId: origin, delegate: true,
    }, HEADERS)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'dup-1', name: 'pwsh', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'off-dup', toolName: 'pwsh', callId: 'dup-1' }),
    )
    snapshotReal(gateway, sessionId, 'dup-1', 'pwsh', { command: 'x' })
    const held = ask(gateway, sessionId, 'pwsh', 'dup-1')
    const listed = await (async () => {
      const deadline = Date.now() + 5000
      for (;;) {
        const res = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId), HEADERS)
        if (res.body.ok === true && res.body.approvals.some((p) => p.callId === 'dup-1')) return res
        if (Date.now() > deadline) return res
        await sleep(30)
      }
    })()
    const live = listed.body.approvals.filter((p) => p.state === 'pending')
    assert.equal(live.length, 1)
    const liveKeys = new Set(live.map((p) => p.approvalKey))
    const duplicated = (listed.body.unanswerable || []).filter((u) => liveKeys.has(u.approvalKey))
    assert.deepEqual(duplicated, [], '活跃 pending 不得同时列为 unanswerable（这是真实 profile 的重复上报）')
    // MCP 视角同样不重复
    const round = await runMcp({ DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }, [
      mcpInit(0),
      mcpCall(1, 'dsh_approvals', { originThreadId: origin, taskId }),
    ], 20000)
    const mcpPayload = payloadOf(round.get(1))
    const mcpLive = new Set((mcpPayload.approvals || []).filter((p) => p.state === 'pending').map((p) => p.approvalKey))
    assert.equal((mcpPayload.unanswerable || []).filter((u) => mcpLive.has(u.approvalKey)).length, 0, 'MCP 输出也不得重复')
    const decided = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + [...mcpLive][0] + '/decide', {
      originThreadId: origin, taskId, grantId: live[0].grantId, fingerprint: live[0].fingerprint, decision: 'reject',
    }, HEADERS)
    assert.equal(decided.status, 200)
    // C) reject 文案：不得提示去等 confirmed，应指向 rejected
    assert.equal(String(decided.body.confirmationHint).includes('rejected'), true, 'reject 的提示必须指向官方 rejected 终态: ' + decided.body.confirmationHint)
    assert.equal(String(decided.body.confirmationHint).includes('state=confirmed'), false, 'reject 不得诱导去等 confirmed')
    assert.equal(await held.promise, 'rejected')
  } finally {
    await gateway.close()
  }
})

test('B: 重启（新 store，无内存回调）后仍恢复：未决定→unanswerable、submitted→decision-unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-restart-store-'))
  try {
    const digest = controlCredDigest('a'.repeat(64))
    const store = openApprovalStore({ root })
    const grant = store.issueGrant({ originThreadId: 'origin-r', taskId: 't-r', scope: { kind: 'session', sessionId: 'sess-r' }, credDigest: digest })
    const execution = (callId) => {
      store.snapshotCall({ sessionId: 'sess-r', callId, rootCallId: callId, name: 'pwsh', args: { command: 'x' }, cwd: 'E:/work' })
      store.annotateSnapshot('sess-r', callId, { turn: 1, step: 1 })
      const live = store.getSnapshot('sess-r', callId)
      return {
        snapshotId: live.snapshotId, sessionId: 'sess-r', callId, toolName: 'pwsh', rootCallId: callId,
        parentKey: live.parentKey, cwd: live.cwd, cwdSource: live.cwdSource, args: live.args,
        turn: live.turn, step: live.step, turnSource: live.turnSource, stepSource: live.stepSource,
      }
    }
    const undecided = store.openPending({ execution: execution('r-1'), grant })
    const submitted = store.openPending({ execution: execution('r-2'), grant })
    store.observeOfficialAsked({ officialId: 'off-r-1', sessionId: 'sess-r', toolName: 'pwsh', callId: 'r-1' })
    store.observeOfficialAsked({ officialId: 'off-r-2', sessionId: 'sess-r', toolName: 'pwsh', callId: 'r-2' })
    store.claimOfficialAsk(undecided.approvalKey, 'off-r-1')
    store.claimOfficialAsk(submitted.approvalKey, 'off-r-2')
    // 运行中：两者都在内存里 → 都不该作为"重启残留"出现
    const live = store.unansweredFromAudit()
    assert.equal(live.some((r) => r.approvalKey === undecided.approvalKey || r.approvalKey === submitted.approvalKey), false, '运行中不得把活跃项当重启残留')
    store.decide({
      approvalKey: submitted.approvalKey, fingerprint: submitted.fingerprint, decision: 'approve-once',
      originThreadId: 'origin-r', taskId: 't-r', grantId: grant.grantId, credDigest: digest, currentTurnStep: { turn: 1, step: 1 },
    })
    // 重启：新实例无内存 pending
    const reopened = openApprovalStore({ root })
    const recovered = reopened.unansweredFromAudit()
    assert.equal(recovered.find((r) => r.approvalKey === undecided.approvalKey)?.state, 'unanswerable')
    assert.equal(recovered.find((r) => r.approvalKey === undecided.approvalKey)?.live, false)
    assert.equal(recovered.find((r) => r.approvalKey === submitted.approvalKey)?.state, APPROVAL_STATES.DECISION_UNKNOWN)
    assert.equal(recovered.find((r) => r.approvalKey === submitted.approvalKey)?.live, false)
  } finally {
    const temp = path.resolve(os.tmpdir()) + path.sep
    const resolved = path.resolve(root)
    if (resolved.startsWith(temp) && path.basename(resolved).startsWith('approval-restart-store-')) fs.rmSync(resolved, { recursive: true, force: true })
  }
})
