/**
 * 审批委托 e2e（独立验收修正版）：真实 HTTP 网关 + 独立 MCP 进程 + 独立 CLI 进程。
 *
 * 覆盖：委托派活零执行前置；完整闭环（不可变快照 → 官方 asked 身份认领 → needs-approval 非终态 →
 * 鉴权 + origin/task 硬核对 → MCP 决定（错指纹/幂等）→ 官方 confirmed → CLI 第二次决定 → 同任务结果）；
 * 不吞链负向集；**租约驱动**的等待（无 25s 硬上限；认证续租保活；到期交还且关闭可答状态）；
 * signal→cancelled；enable/revoke；能力与 MCP 预检（含 delegated dispatch 必须带认证头）。
 *
 * 全部独立临时 root + 自建 key；不碰真实用户凭据/策略。跑法: node test/approval-e2e.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  disposeAll,
  makeTmp,
  startGateway,
  runCli,
  runMcp,
  mcpInit,
  mcpCall,
  payloadOf,
} from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-e2e-key-'))
const keyPath = path.join(keyDir, 'control.key')
initControlKey({ path: keyPath })
const RAW_KEY = fs.readFileSync(keyPath, 'utf8').trim()
const HEADERS = { 'X-Dsh-Control': RAW_KEY }
process.env.DSH_APPROVAL_CONTROL_KEY_PATH = keyPath
const CLIENT_ENV = { DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }

after(async () => {
  delete process.env.DSH_APPROVAL_CONTROL_KEY_PATH
  await disposeAll()   // 与 makeTmp 前缀匹配：清掉所有网关/子进程/临时目录
  try { fs.rmSync(keyDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})

const ev = (seq, type, data) => ({ seq, type, data })
const statusUrl = (base, taskId, origin) => base + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=' + encodeURIComponent(origin)
const approvalsUrl = (base, origin, taskId, extra = '') => base + '/api/dsh-bridge/approvals?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + encodeURIComponent(taskId) + extra

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
  const assocRoot = await makeTmp('approval-assoc-')
  const storeRoot = await makeTmp('approval-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot } })
  const readJsonl = (name) => {
    try {
      return fs.readFileSync(path.join(storeRoot, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch (e) { return [] }
  }
  return {
    gateway, events, storeRoot, assocRoot,
    grantRows: () => readJsonl('grants.jsonl').filter((r) => r.type === 'grant'),
    auditRows: () => readJsonl('audit.jsonl'),
    auditText: () => { try { return fs.readFileSync(path.join(storeRoot, 'audit.jsonl'), 'utf8') } catch (e) { return '' } },
  }
}

const dispatchDelegate = (gateway, origin, sessionId, extra = {}) =>
  postJson(gateway.url + '/api/dsh-bridge/task', { instruction: '审批闭环任务', sessionId, deliver: 'queue', originThreadId: origin, delegate: true, authorization: '允许在本项目临时目录做读写验证', ...extra }, HEADERS)

const snapshot = (gateway, sessionId, callId, name, args, cwd, rootCallId) =>
  gateway.emitCtx('tools/pre-execute', {
    agent: { session: { id: sessionId }, cwd },
    callId, rootCallId: rootCallId === undefined ? callId : rootCallId, name, arguments: args, cwd,
  }, () => ({ kind: 'allow' }))

const ask = (gateway, sessionId, toolName, callId, extra = {}) => {
  const state = { humanNext: 0 }
  const results = gateway.emitCtx('approval/request', {
    agent: { session: { id: sessionId } }, toolName, callId,
    reason: 'escalate sandbox to workspace-write: fixture justification',
    displayReason: { en: 'Allow this operation', zh: '允许本次操作' },
    ...extra,
  }, () => { state.humanNext += 1; return Promise.resolve('rejected') })
  return { promise: results[0], state }
}

// ---------------------------------------------------------------- T1: 派活前置零执行

test('委托派活：缺凭据/worker/缺来源/grant 签发失败全部零执行；成功路径先有 grant 后有 prompt', async () => {
  const env = await setup()
  const { gateway } = env
  const taskRoute = gateway.url + '/api/dsh-bridge/task'
  try {
    const noAuth = await postJson(taskRoute, { instruction: '不该出去', sessionId: 'sess-a', originThreadId: 'origin-A', delegate: true })
    assert.equal(noAuth.status, 401)
    assert.equal(gateway.prompts.length, 0)

    const badAuth = await postJson(taskRoute, { instruction: '不该出去2', sessionId: 'sess-a', originThreadId: 'origin-A', delegate: true }, { 'X-Dsh-Control': 'f'.repeat(64) })
    assert.equal(badAuth.status, 401)
    assert.equal(gateway.prompts.length, 0)

    const worker = await postJson(taskRoute, { instruction: 'worker 不支持委托', cwd: 'E:/tmp/appr-worker', originThreadId: 'origin-A', delegate: true }, HEADERS)
    assert.equal(worker.status, 400)
    assert.equal(worker.body.reason, 'approval-unsupported-target')
    assert.equal(gateway.starts.length, 0)

    const noOrigin = await postJson(taskRoute, { instruction: '缺来源', sessionId: 'sess-a', delegate: true }, HEADERS)
    assert.equal(noOrigin.status, 400)
    assert.equal(noOrigin.body.reason, 'origin-required')
    assert.equal(gateway.prompts.length, 0)

    fs.mkdirSync(path.join(env.storeRoot, 'grants.jsonl'), { recursive: true })
    const issueFail = await postJson(taskRoute, { instruction: 'grant 失败也不许发', sessionId: 'sess-a', originThreadId: 'origin-A', delegate: true }, HEADERS)
    assert.equal(issueFail.status, 400)
    assert.equal(issueFail.body.reason, 'grant-issue-failed')
    assert.equal(gateway.prompts.length, 0, 'grant 签发失败必须零派活（grant 先于 prompt）')
    fs.rmSync(path.join(env.storeRoot, 'grants.jsonl'), { recursive: true, force: true })

    const ok = await dispatchDelegate(gateway, 'origin-A', 'sess-a')
    assert.equal(ok.status, 202, JSON.stringify(ok.body))
    assert.equal(gateway.prompts.length, 1)
    const grantRows = env.grantRows()
    assert.equal(grantRows.length, 1)
    assert.equal(grantRows[0].taskId, ok.body.taskId)
    assert.equal(grantRows[0].authorization, '允许在本项目临时目录做读写验证')
    assert.equal(env.auditText().includes(RAW_KEY), false, '审计不得出现 raw 控制 key')
    assert.equal(JSON.stringify(grantRows[0]).includes(RAW_KEY), false, 'grant 记录不得出现 raw 控制 key')

    const legacy = await postJson(taskRoute, { instruction: 'legacy worker', cwd: 'E:/tmp/appr-legacy' })
    assert.equal(legacy.status, 202, '无 delegate 的旧 worker 路径保持兼容')
    assert.equal(await gateway.waitForChild('legacy worker'), true)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- T2: 完整闭环

test('完整闭环：委托派活 → 官方 asked 认领 → MCP 决定 → confirmed → CLI 第二次 → 同任务结果', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-closed-loop'
  const sessionId = 'sess-appr'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body))
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId

    let seq = 1
    events.push(
      ev(seq++, 'turn/start', { turn: 1 }),
      ev(seq++, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '审批闭环任务' }], source: { rpcId: taskId } }),
      ev(seq++, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' }),
      ev(seq++, 'approval/asked', { id: 'official-1', toolName: 'bash', callId: 'call-1', reason: 'fixture' }),
    )
    gateway.emitCtx('api-session/status', sessionId, true)
    snapshot(gateway, sessionId, 'call-1', 'bash', { command: 'ls -la', sandbox_permissions: 'workspace-write' }, 'E:/work')

    const first = ask(gateway, sessionId, 'bash', 'call-1')

    const pendingStatus = await until(async () => {
      const res = await getJson(statusUrl(gateway.url, taskId, origin))
      return res.body !== null && res.body.status === 'needs-approval' ? res : false
    })
    assert.equal(pendingStatus.body.status, 'needs-approval', '审批挂起时任务必须及时变为 needs-approval（非终态）')
    assert.equal(pendingStatus.body.needsApproval, true)
    assert.equal(pendingStatus.body.args, undefined, '公开 status 不得带审批正文')

    await gateway.runIntervals()
    assert.equal((await getJson(statusUrl(gateway.url, taskId, origin))).body.status, 'needs-approval', 'sweep 不得把等待审批的任务误收成终态')

    // ---- 鉴权 + origin/task 硬核对
    assert.equal((await getJson(gateway.url + '/api/dsh-bridge/approvals')).status, 401, '清单必须鉴权')
    const missingCtx = await getJson(approvalsUrl(gateway.url, origin, ''), HEADERS)
    assert.equal(missingCtx.status, 400, '空过滤（缺 taskId）必须拒绝，不得顺手续所有任务租约')
    assert.equal(missingCtx.body.reason, 'task-required')
    const wrongOrigin = await getJson(approvalsUrl(gateway.url, 'origin-other', taskId, '&grantId=' + encodeURIComponent(grantId)), HEADERS)
    assert.equal(wrongOrigin.status, 200)
    assert.equal(wrongOrigin.body.grants.length, 0, '错来源不得看到该 grant')
    assert.equal(wrongOrigin.body.approvals.length, 0, '错来源不得看到审批（零副作用）')

    const list = await getJson(approvalsUrl(gateway.url, origin, taskId, '&grantId=' + encodeURIComponent(grantId)), HEADERS)
    assert.equal(list.status, 200)
    assert.equal(list.body.renewedGrants.includes(grantId), true, '认证 + 匹配该 task/origin/grant 的查询会续租')
    const approval = list.body.approvals[0]
    assert.equal(approval.state, 'pending')
    assert.equal(approval.toolName, 'bash')
    assert.equal(approval.args.command, 'ls -la', '详情必须带宿主侧真实参数（不可变副本）')
    assert.equal(approval.cwd, 'E:/work')
    assert.equal(approval.turn, 1)
    assert.equal(approval.step, 1)
    assert.equal(approval.officialId, 'official-1', '官方 ask 身份必须唯一认领后才可决定')
    assert.match(approval.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(approval.originThreadId, origin)
    assert.equal(approval.authorization, '允许在本项目临时目录做读写验证')
    const approvalKey = approval.approvalKey

    // 错误 origin 的详情/决定必须零副作用
    assert.equal((await getJson(gateway.url + '/api/dsh-bridge/approvals/' + approvalKey + '?originThreadId=origin-other&taskId=' + taskId, HEADERS)).status, 403)
    const wrongDecide = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + approvalKey + '/decide', { originThreadId: 'origin-other', taskId, grantId, fingerprint: approval.fingerprint, decision: 'approve-once' }, HEADERS)
    assert.equal(wrongDecide.status, 403)
    const midCheck = await getJson(approvalsUrl(gateway.url, origin, taskId), HEADERS)
    assert.equal(midCheck.status, 200, '中段清单必须 200: ' + JSON.stringify(midCheck.body))
    assert.equal(midCheck.body.approvals.length, 1, '中段清单必须仍是同一条 pending: ' + JSON.stringify(midCheck.body))
    assert.equal(midCheck.body.approvals[0].state, 'pending', '错来源试图决定不得改变状态')
    // 参数副本/多余字段一律拒绝
    const extraField = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + approvalKey + '/decide', { originThreadId: origin, taskId, grantId, fingerprint: approval.fingerprint, decision: 'approve-once', args: { command: 'rm -rf /' } }, HEADERS)
    assert.equal(extraField.status, 400)
    assert.equal(extraField.body.reason, 'unexpected-fields')
    // 缺 fingerprint 也必须拒绝
    assert.equal((await postJson(gateway.url + '/api/dsh-bridge/approvals/' + approvalKey + '/decide', { originThreadId: origin, taskId, grantId, decision: 'approve-once' }, HEADERS)).status, 400)

    // ---- MCP：错指纹拒绝 → 正确提交 → 幂等重放
    const mcpEnv = { DSH_BRIDGE_URL: gateway.url, ...CLIENT_ENV }
    const round = await runMcp(mcpEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_approvals', { originThreadId: origin, taskId, grantId }),
      mcpCall(2, 'dsh_approval_decide', { originThreadId: origin, taskId, approvalKey, grantId, fingerprint: 'e'.repeat(64), decision: 'approve-once' }),
      mcpCall(3, 'dsh_approval_decide', { originThreadId: origin, taskId, approvalKey, grantId, fingerprint: approval.fingerprint, decision: 'approve-once', idempotencyKey: 'idem-1' }),
      mcpCall(4, 'dsh_approval_decide', { originThreadId: origin, taskId, approvalKey, grantId, fingerprint: approval.fingerprint, decision: 'approve-once', idempotencyKey: 'idem-1' }),
      mcpCall(5, 'dsh_approval_decide', { originThreadId: origin, taskId, approvalKey, grantId, fingerprint: approval.fingerprint, decision: 'approve-once', command: 'rm -rf /' }),
    ], 30000)
    assert.equal(payloadOf(round.get(1)).ok, true)
    assert.equal(payloadOf(round.get(1)).approvals.length, 1)
    assert.equal(payloadOf(round.get(2)).reason, 'fingerprint-mismatch')
    const decided = payloadOf(round.get(3))
    assert.equal(decided.ok, true, JSON.stringify(decided))
    assert.equal(decided.phase, 'submitted')
    assert.equal(decided.outcome, 'allowed-once')
    assert.equal(payloadOf(round.get(4)).idempotent, true)
    assert.equal(payloadOf(round.get(5)).reason, 'unexpected-fields', 'MCP 也必须拒绝参数副本')

    const outcome1 = await first.promise
    assert.equal(outcome1, 'allowed-once')
    assert.equal(first.state.humanNext, 0, '被接管的请求不走向人工链')

    const afterDecide = await until(async () => {
      const res = await getJson(statusUrl(gateway.url, taskId, origin))
      return res.body.status === 'running' ? res : false
    })
    assert.equal(afterDecide.body.status, 'running')

    // ---- 官方确认环：decided 观测 → confirmed + officialId
    events.push(ev(seq++, 'approval/decided', { id: 'official-1', outcome: 'allowed-once' }))
    await gateway.runIntervals()
    const confirmed = await until(async () => {
      const res = await getJson(gateway.url + '/api/dsh-bridge/approvals/' + approvalKey + '?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + taskId, HEADERS)
      return res.body.approval !== undefined && res.body.approval.state === 'confirmed' ? res : false
    })
    assert.equal(confirmed.body.approval.state, 'confirmed', '必须区分 submitted 与官方 confirmed')
    assert.equal(confirmed.body.approval.confirmedOutcome, 'allowed-once')

    // ---- 第二次审批走独立 CLI
    events.push(
      ev(seq++, 'tool/call', { turn: 1, step: 2, callId: 'call-2', name: 'bash', arguments: '{"command":"cp a b"}' }),
      ev(seq++, 'approval/asked', { id: 'official-2', toolName: 'bash', callId: 'call-2' }),
    )
    snapshot(gateway, sessionId, 'call-2', 'bash', { command: 'cp a b' }, 'E:/work')
    const second = ask(gateway, sessionId, 'bash', 'call-2')
    await until(async () => {
      const res = await getJson(statusUrl(gateway.url, taskId, origin))
      return res.body.status === 'needs-approval' ? res : false
    })

    const cliEnv = { DSH_BRIDGE_URL: gateway.url, ...CLIENT_ENV }
    const cliList = await runCli(['--approvals', '--origin', origin, '--task', taskId, '--grant', grantId], cliEnv)
    assert.equal(cliList.status, 9, 'CLI 有待审项时退出码 9: ' + cliList.stderr)
    const approval2 = JSON.parse(cliList.stdout).approvals.find((p) => p.callId === 'call-2')
    assert.notEqual(approval2, undefined)
    const cliMissing = await runCli(['--approve', approval2.approvalKey, '--origin', origin, '--task', taskId, '--grant', grantId], cliEnv)
    assert.equal(cliMissing.status, 2, '缺 --fingerprint 属用法错误')
    const cliDecide = await runCli(['--approve', approval2.approvalKey, '--origin', origin, '--task', taskId, '--grant', grantId, '--fingerprint', approval2.fingerprint, '--idem', 'idem-2'], cliEnv)
    assert.equal(cliDecide.status, 0, 'CLI 决定应成功: ' + cliDecide.stderr)
    assert.equal(JSON.parse(cliDecide.stdout).phase, 'submitted')
    assert.equal(await second.promise, 'allowed-once')
    assert.equal(second.state.humanNext, 0)

    // ---- 同一任务收尾取结果
    events.push(
      ev(seq++, 'assistant/message', { turn: 1, step: 3, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'APPROVAL TASK RESULT' }] } }),
      ev(seq++, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )
    gateway.emitCtx('api-session/status', sessionId, false)
    const done = await until(async () => {
      const res = await getJson(statusUrl(gateway.url, taskId, origin))
      return res.body.status === 'done' ? res : false
    }, { timeoutMs: 8000 })
    assert.equal(done.body.status, 'done', '两次审批后同一任务必须取回终态')
    assert.equal(done.body.result, 'APPROVAL TASK RESULT')

    // ---- 审计与凭据卫生
    const audit = env.auditText()
    assert.equal(audit.includes(RAW_KEY), false, '审计绝不写 raw 控制凭据')
    assert.equal(audit.includes('ls -la'), false, '审计不落命令原文（只留 argsSha256）')
    const submittedRows = env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted')
    assert.equal(submittedRows.length, 2, '两次决定各一条 intent 审计')
    assert.equal(submittedRows.every((r) => /^[0-9a-f]{64}$/.test(r.argsSha256)), true)
    assert.equal(submittedRows.every((r) => r.originThreadId === origin && r.officialId !== undefined), true, '审计记录来源与官方身份')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- T3: 不吞链

test('不吞链：无委托/无快照/无 callId/工具不符/PTC 嵌套/父子混淆/无 turn·step/非本 turn → 全部 next()', async () => {
  const env = await setup()
  const { gateway, events } = env
  const sessionId = 'sess-neg'
  try {
    const dispatched = await dispatchDelegate(gateway, 'origin-neg', sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    events.push(
      ev(1, 'turn/start', { turn: 5 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
    )

    const other = ask(gateway, 'sess-undelegated', 'bash', 'call-x')
    assert.equal(await other.promise, 'rejected')
    assert.equal(other.state.humanNext, 1)

    const noCallId = ask(gateway, sessionId, 'bash', '')
    assert.equal(await noCallId.promise, 'rejected')
    assert.equal(noCallId.state.humanNext, 1)

    const noSnapshot = ask(gateway, sessionId, 'bash', 'call-ghost')
    assert.equal(await noSnapshot.promise, 'rejected')
    assert.equal(noSnapshot.state.humanNext, 1)

    snapshot(gateway, sessionId, 'call-name', 'bash', { command: 'ls' }, 'E:/w')
    events.push(ev(3, 'tool/call', { turn: 5, step: 1, callId: 'call-name', name: 'bash', arguments: '{}' }), ev(4, 'approval/asked', { id: 'o-name', toolName: 'bash', callId: 'call-name' }))
    const nameMismatch = ask(gateway, sessionId, 'dsh-apply-patch', 'call-name')
    assert.equal(await nameMismatch.promise, 'rejected')
    assert.equal(nameMismatch.state.humanNext, 1)

    snapshot(gateway, sessionId, 'call-p1:ptc:2', 'bash', { command: 'ls' }, 'E:/w')
    events.push(ev(5, 'tool/call', { turn: 5, step: 1, callId: 'call-p1:ptc:2', name: 'bash', arguments: '{}' }), ev(6, 'approval/asked', { id: 'o-ptc', toolName: 'bash', callId: 'call-p1:ptc:2' }))
    const ptc = ask(gateway, sessionId, 'bash', 'call-p1:ptc:2')
    assert.equal(await ptc.promise, 'rejected')
    assert.equal(ptc.state.humanNext, 1)

    snapshot(gateway, sessionId, 'call-child', 'bash', { command: 'ls' }, 'E:/w', 'call-parent')
    events.push(ev(7, 'tool/call', { turn: 5, step: 1, callId: 'call-child', name: 'bash', arguments: '{}' }), ev(8, 'approval/asked', { id: 'o-child', toolName: 'bash', callId: 'call-child' }))
    const parentMismatch = ask(gateway, sessionId, 'bash', 'call-child')
    assert.equal(await parentMismatch.promise, 'rejected')
    assert.equal(parentMismatch.state.humanNext, 1)

    // 没有 tool/call（证明不了 turn+step）→ next()
    snapshot(gateway, sessionId, 'call-noturn', 'bash', { command: 'ls' }, 'E:/w')
    events.push(ev(9, 'approval/asked', { id: 'o-noturn', toolName: 'bash', callId: 'call-noturn' }))
    const noTurn = ask(gateway, sessionId, 'bash', 'call-noturn')
    assert.equal(await noTurn.promise, 'rejected', '证明不了 turn/step 必须拒绝接手')
    assert.equal(noTurn.state.humanNext, 1)

    // tool/call 的 turn 不是自己那个 turn → next()
    snapshot(gateway, sessionId, 'call-otherturn', 'bash', { command: 'ls' }, 'E:/w')
    events.push(ev(10, 'tool/call', { turn: 99, step: 1, callId: 'call-otherturn', name: 'bash', arguments: '{}' }), ev(11, 'approval/asked', { id: 'o-otherturn', toolName: 'bash', callId: 'call-otherturn' }))
    const otherTurn = ask(gateway, sessionId, 'bash', 'call-otherturn')
    assert.equal(await otherTurn.promise, 'rejected', '不是自己绑定的 turn 必须交还人工')
    assert.equal(otherTurn.state.humanNext, 1)

    // 歧义：两个未认领的官方 ask 同 (callId, toolName) → next()（不猜、不合并）
    snapshot(gateway, sessionId, 'call-amb', 'bash', { command: 'ls' }, 'E:/w')
    events.push(
      ev(12, 'tool/call', { turn: 5, step: 2, callId: 'call-amb', name: 'bash', arguments: '{}' }),
      ev(13, 'approval/asked', { id: 'o-amb-1', toolName: 'bash', callId: 'call-amb' }),
      ev(14, 'approval/asked', { id: 'o-amb-2', toolName: 'bash', callId: 'call-amb' }),
    )
    const ambiguous = ask(gateway, sessionId, 'bash', 'call-amb')
    assert.equal(await ambiguous.promise, 'rejected', '官方身份歧义必须交还人工')
    assert.equal(ambiguous.state.humanNext, 1)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- T4: 租约驱动的等待

test('等待由**有效租约**驱动：认证续租可保活；租约到期交还人工且关闭可答状态；signal→cancelled', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-lease'
  const sessionId = 'sess-lease'
  try {
    // lease 300ms：不续租时到期必须交还（旧实现的 25s 硬上限已移除）
    const dispatched = await dispatchDelegate(gateway, origin, sessionId, { delegateLeaseSec: 1 })
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId
    events.push(
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 1, step: 1, callId: 'call-slow', name: 'bash', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'o-slow', toolName: 'bash', callId: 'call-slow' }),
    )
    snapshot(gateway, sessionId, 'call-slow', 'bash', { command: 'sleep 999' }, 'E:/w')

    const held = ask(gateway, sessionId, 'bash', 'call-slow')
    const seen = await until(async () => {
      const res = await getJson(approvalsUrl(gateway.url, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.some((p) => p.callId === 'call-slow') ? res : false
    })
    assert.notEqual(seen, false, '应真正挂起等待决定')
    const key = seen.body.approvals.find((p) => p.callId === 'call-slow').approvalKey
    const fingerprint = seen.body.approvals.find((p) => p.callId === 'call-slow').fingerprint

    // 认证续租 1.2s（> 初始 1s 租约）→ 仍然可答（证明等待不再被固定 25s/初始租约限制）
    const renewDeadline = Date.now() + 1200
    while (Date.now() < renewDeadline) {
      await getJson(approvalsUrl(gateway.url, origin, taskId, '&grantId=' + encodeURIComponent(grantId)), HEADERS)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const stillPending = await getJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '?originThreadId=' + encodeURIComponent(origin) + '&taskId=' + taskId, HEADERS)
    assert.equal(stillPending.body.approval.state, 'pending', '认证续租期间必须仍然可答')

    // 用第二次执行的指纹去决定 → 拒绝（不可变快照身份核对）
    const wrongCtx = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '/decide', { originThreadId: origin, taskId, grantId, fingerprint: 'a'.repeat(64), decision: 'approve-once' }, HEADERS)
    assert.equal(wrongCtx.status, 409)
    assert.equal(wrongCtx.body.reason, 'fingerprint-mismatch')

    // 停止续租 → 租约到期 → 交还人工；且**交还后关闭可答状态**（迟到批准不能再被接受）
    const outcome = await held.promise
    assert.equal(outcome, 'rejected', '租约到期必须交还人工')
    assert.equal(held.state.humanNext, 1)
    const late = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + key + '/decide', { originThreadId: origin, taskId, grantId, fingerprint, decision: 'approve-once' }, HEADERS)
    assert.equal(late.status, 409, '交还之后迟到批准必须被拒绝')
    assert.notEqual(late.body.reason, undefined)
    const status = await getJson(statusUrl(gateway.url, taskId, origin))
    assert.equal(status.body.status, 'needs-approval', '等待人工的任务保持非终态')
    assert.equal(env.auditRows().filter((r) => r.type === 'decision' && r.phase === 'submitted').length, 0, '到期路径不得产生任何决定审计')

    // signal 中止 → cancelled
    events.push(
      ev(5, 'tool/call', { turn: 1, step: 2, callId: 'call-abort', name: 'bash', arguments: '{}' }),
      ev(6, 'approval/asked', { id: 'o-abort', toolName: 'bash', callId: 'call-abort' }),
    )
    snapshot(gateway, sessionId, 'call-abort', 'bash', { command: 'ls' }, 'E:/w')
    const controller = new AbortController()
    const aborted = ask(gateway, sessionId, 'bash', 'call-abort', { signal: controller.signal })
    await until(async () => {
      const res = await getJson(approvalsUrl(gateway.url, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.some((p) => p.callId === 'call-abort')
    })
    controller.abort()
    assert.equal(await aborted.promise, 'cancelled')
    assert.equal(aborted.state.humanNext, 0)
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- T5: enable / 撤销

test('enable 只对已绑定来源的既有任务生效；撤销后在途与新请求都交还人工', async () => {
  const env = await setup()
  const { gateway, events } = env
  const origin = 'origin-enable'
  const sessionId = 'sess-enable'
  try {
    const dispatched = await dispatchDelegate(gateway, origin, sessionId)
    assert.equal(dispatched.status, 202)
    const taskId = dispatched.body.taskId
    const grantId = env.grantRows()[0].grantId

    const enable = await postJson(gateway.url + '/api/dsh-bridge/approvals/enable', { originThreadId: origin, taskId, sessionId }, HEADERS)
    assert.equal(enable.status, 200, JSON.stringify(enable.body))
    assert.equal(enable.body.reused, true)
    assert.equal((await postJson(gateway.url + '/api/dsh-bridge/approvals/enable', { originThreadId: origin, taskId, sessionId: 'sess-other' }, HEADERS)).status, 400)
    assert.equal((await postJson(gateway.url + '/api/dsh-bridge/approvals/enable', { originThreadId: origin, taskId: 'grt-none', sessionId }, HEADERS)).status, 404)
    assert.equal((await postJson(gateway.url + '/api/dsh-bridge/approvals/enable', { originThreadId: 'origin-other', taskId, sessionId }, HEADERS)).status, 403, '错来源不得 enable')
    assert.equal((await postJson(gateway.url + '/api/dsh-bridge/approvals/enable', { originThreadId: origin, taskId, sessionId })).status, 401)

    events.push(
      ev(1, 'turn/start', { turn: 2 }),
      ev(2, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { rpcId: taskId } }),
      ev(3, 'tool/call', { turn: 2, step: 1, callId: 'call-before', name: 'bash', arguments: '{}' }),
      ev(4, 'approval/asked', { id: 'o-before', toolName: 'bash', callId: 'call-before' }),
    )
    snapshot(gateway, sessionId, 'call-before', 'bash', { command: 'ls' }, 'E:/w')
    const pre = ask(gateway, sessionId, 'bash', 'call-before')
    await until(async () => {
      const res = await getJson(approvalsUrl(gateway.url, origin, taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.some((p) => p.callId === 'call-before')
    })
    const revoke = await postJson(gateway.url + '/api/dsh-bridge/approvals/grants/' + encodeURIComponent(grantId) + '/revoke', { originThreadId: origin, taskId, grantId, reason: 'no longer trusted' }, HEADERS)
    assert.equal(revoke.status, 200)
    assert.equal(await pre.promise, 'rejected', '撤销后在途等待必须交还人工')
    assert.equal(pre.state.humanNext, 1)

    events.push(
      ev(5, 'tool/call', { turn: 2, step: 2, callId: 'call-after', name: 'bash', arguments: '{}' }),
      ev(6, 'approval/asked', { id: 'o-after', toolName: 'bash', callId: 'call-after' }),
    )
    snapshot(gateway, sessionId, 'call-after', 'bash', { command: 'ls' }, 'E:/w')
    const post = ask(gateway, sessionId, 'bash', 'call-after')
    assert.equal(await post.promise, 'rejected', '撤销后的新请求一律交给人工')
    assert.equal(post.state.humanNext, 1)

    // 撤销后的续期也不得复活
    const renewAfterRevoke = await postJson(gateway.url + '/api/dsh-bridge/approvals/grants/' + encodeURIComponent(grantId) + '/renew', { originThreadId: origin, taskId, grantId, extendSec: 600 }, HEADERS)
    assert.equal(renewAfterRevoke.status, 409)
    assert.equal(renewAfterRevoke.body.reason, 'grant-revoked')
  } finally {
    await gateway.close()
  }
})

// ---------------------------------------------------------------- T6: 能力与 MCP 预检

test('能力元数据非敏感；缺 key 时关闭；MCP 预检零执行；delegated dispatch 必须带认证头', async () => {
  const env = await setup()
  const { gateway } = env
  try {
    const status = await getJson(gateway.url + '/api/dsh-bridge/status')
    const approvals = status.body.capabilities.approvals
    assert.equal(approvals.supported, true)
    assert.equal(approvals.enabled, true)
    assert.match(approvals.keyFp, /^[0-9a-f]{8}$/)
    assert.equal(approvals.workerSupported, false)
    assert.equal(approvals.ptcSupported, false)
    assert.equal(approvals.canWakeIdle, false)
    assert.equal(JSON.stringify(approvals).includes(RAW_KEY), false, '能力里不得出现 raw key')

    // 缺 key → 关闭 + 401
    const saved = process.env.DSH_APPROVAL_CONTROL_KEY_PATH
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = path.join(keyDir, 'missing.key')
    try {
      assert.equal((await getJson(gateway.url + '/api/dsh-bridge/status')).body.capabilities.approvals.enabled, false)
      const rejected = await getJson(approvalsUrl(gateway.url, 'o', 't'), HEADERS)
      assert.equal(rejected.status, 401)
      assert.equal(rejected.body.reason, 'approval-key-missing')
    } finally {
      process.env.DSH_APPROVAL_CONTROL_KEY_PATH = saved
    }

    // MCP：delegate 派活必须真的带上认证头（否则旧稿会 401）
    const baseEnv = { DSH_BRIDGE_URL: gateway.url, ...CLIENT_ENV }
    const delegated = await runMcp(baseEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: 'MCP 委托派活', sessionId: 'sess-mcp', originThreadId: 'origin-mcp', delegate: true, wait: false }),
    ], 20000)
    const delegatedPayload = payloadOf(delegated.get(1))
    assert.equal(delegatedPayload.taskId !== undefined, true, 'MCP 委托派活应成功: ' + JSON.stringify(delegatedPayload))
    assert.equal(gateway.prompts.length, 1, 'MCP 委托派活确实带上了认证头并投递')
    assert.equal(env.grantRows().some((g) => g.taskId === delegatedPayload.taskId), true, 'MCP 委托派活必须真的签发 grant')

    // MCP：worker 委托零执行
    const workerPreflight = await runMcp(baseEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: '不该跑', cwd: 'E:/tmp/appr-p1', originThreadId: 'origin-p', delegate: true, wait: false }),
    ], 20000)
    assert.equal(payloadOf(workerPreflight.get(1)).reason, 'approval-unsupported-target')
    assert.equal(gateway.starts.length, 0)

    // MCP：缺来源零执行
    const noOrigin = await runMcp(baseEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: '不该跑2', sessionId: 'sess-p', delegate: true, wait: false }),
    ], 20000)
    assert.equal(payloadOf(noOrigin.get(1)).reason, 'origin-required')
    assert.equal(gateway.prompts.length, 1)

    // MCP：审批查询缺 origin/task → 零执行
    const noCtx = await runMcp(baseEnv, [mcpInit(0), mcpCall(1, 'dsh_approvals', { taskId: 't' })], 20000)
    assert.equal(payloadOf(noCtx.get(1)).reason, 'origin-and-task-required')

    // MCP：本机缺 key → 零执行
    const noKey = await runMcp({ DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: path.join(keyDir, 'missing.key') }, [
      mcpInit(0),
      mcpCall(1, 'dsh_task', { instruction: '不该跑3', sessionId: 'sess-p', originThreadId: 'origin-p', delegate: true, wait: false }),
    ], 20000)
    assert.equal(payloadOf(noKey.get(1)).reason, 'approval-key-missing')

    // 旧网关（/status 404）→ 预检拒绝、零任务
    const bare = http.createServer((req, res) => { res.writeHead(404); res.end('not found') })
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve))
    try {
      const old = await runMcp({ DSH_BRIDGE_URL: 'http://127.0.0.1:' + bare.address().port, ...CLIENT_ENV }, [
        mcpInit(0),
        mcpCall(1, 'dsh_task', { instruction: '不该跑4', sessionId: 'sess-p', originThreadId: 'origin-p', delegate: true, wait: false }),
      ], 20000)
      const oldPayload = payloadOf(old.get(1))
      assert.equal(oldPayload.ok, false)
      assert.equal(oldPayload.taskId, undefined, '旧网关预检拒绝时不得产生任务')
    } finally {
      await new Promise((resolve) => bare.close(resolve))
    }
  } finally {
    await gateway.close()
  }
})
