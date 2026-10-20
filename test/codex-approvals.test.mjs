/**
 * harness/codex-approvals.mjs 单测（独立验收修正版）：控制凭据（raw key 认证 / 摘要不可登录）、
 * grant、不可变执行快照、官方请求身份唯一认领、单次状态机、幂等、严格失败语义、恢复视图。
 *
 * 全部用独立临时 root（不碰真实用户凭据/数据）。跑法: node test/codex-approvals.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  APPROVAL_REASONS,
  APPROVAL_STATES,
  GRANT_STATES,
  DECISIONS,
  MAX_AUTHORIZED_TTL_MS,
  actionFingerprint,
  canonicalParentKey,
  controlCredDigest,
  controlHeaderValue,
  executionIdentityId,
  initControlKey,
  keyFingerprint8,
  openApprovalStore,
  readControlKey,
  sanitizePreview,
  sha256Hex,
  verifyControlHeader,
} from '../harness/codex-approvals.mjs'

const roots = []
const tmpRoot = (prefix = 'codex-approvals-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}
const tmpKeyPath = () => path.join(tmpRoot('codex-approval-key-'), 'control.key')

after(() => {
  const temp = path.resolve(os.tmpdir()) + path.sep
  for (const dir of roots) {
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(temp)) continue
    if (!/^codex-approval/.test(path.basename(resolved))) continue
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

const GRANT = (store, digest, extra = {}) => store.issueGrant({
  originThreadId: 'origin-A', taskId: 't-1', scope: { kind: 'session', sessionId: 'sess-1' },
  ttlMs: 60_000, leaseMs: 60_000, credDigest: digest, ...extra,
})

const EXECUTION = (over = {}) => ({
  snapshotId: 'snap-fixture', sessionId: 'sess-1', callId: 'call-1', toolName: 'bash',
  rootCallId: 'call-1', parentKey: null, cwd: 'E:/work', args: { command: 'ls -la', sandbox_permissions: 'workspace-write' },
  turn: 7, step: 3, turnSource: 'log-tool-call', stepSource: 'log', ...over,
})

/** 真实路径：先落 pre-execute 快照（含完整身份）再标注日志 turn/step，然后按契约构造执行身份。 */
const execOf = (store, { sessionId = 'sess-1', callId = 'call-1', name = 'bash', args = { command: 'ls' }, cwd = 'E:/work', rootCallId, parent, turn = 7, step = 3 } = {}) => {
  store.snapshotCall({ sessionId, callId, rootCallId: rootCallId === undefined ? callId : rootCallId, name, args, cwd, parent })
  store.annotateSnapshot(sessionId, callId, { turn, step })
  const live = store.getSnapshot(sessionId, callId)
  return {
    snapshotId: live.snapshotId, sessionId, callId, toolName: live.name,
    rootCallId: live.rootCallId, parentKey: live.parentKey, cwd: live.cwd, cwdSource: live.cwdSource,
    args: live.args, turn: live.turn, step: live.step, turnSource: live.turnSource, stepSource: live.stepSource,
  }
}

// ---------------------------------------------------------------- 控制凭据（修正 C）

test('控制凭据：raw key 认证；旧 sha256 头与持久摘要都不能登录；格式不合规按无 key', () => {
  const file = tmpKeyPath()
  const created = initControlKey({ path: file })
  const raw = readControlKey(file)
  assert.equal(typeof raw, 'string')
  assert.match(raw, /^[0-9a-f]{64}$/)
  assert.equal(created.fp8, keyFingerprint8(raw), 'init 与 read 的指纹必须一致（不再受尾换行影响）')

  const header = controlHeaderValue(file)
  assert.deepEqual(header, { 'X-Dsh-Control': raw }, '传输的是私有 raw key，不再是 sha256 头')
  assert.equal(verifyControlHeader(raw, raw), true)
  // 旧的 hash-as-bearer 形态必须被拒（未发布开发稿，无兼容旁路）
  assert.equal(verifyControlHeader('sha256:' + sha256Hex(raw), raw), false)
  assert.equal(verifyControlHeader(sha256Hex(raw), raw), false)
  assert.equal(verifyControlHeader('', raw), false)
  assert.equal(verifyControlHeader(raw, null), false)

  // grant/audit 里的持久摘要与认证头**不同域** ⇒ 拿到它无法登录
  const digest = controlCredDigest(raw)
  assert.notEqual(digest, raw)
  assert.notEqual(digest, sha256Hex(raw))
  assert.notEqual(digest.slice('digest:'.length), sha256Hex(raw))
  assert.equal(verifyControlHeader(digest, raw), false)
  assert.equal(verifyControlHeader(digest.slice('digest:'.length), raw), false)

  // 已存在 → 拒绝覆盖；轮换 → 指纹变化
  assert.throws(() => initControlKey({ path: file }), /already exists/)
  const rotated = initControlKey({ path: file, force: true })
  assert.notEqual(rotated.fp8, created.fp8)

  // 格式不合规（任意配置文件内容）→ 视为"无 key"，绝不把任意内容当 header 发出去
  const bogus = tmpKeyPath()
  fs.writeFileSync(bogus, 'not-a-key: some random config value\n', 'utf8')
  assert.equal(readControlKey(bogus), null)
  assert.equal(controlHeaderValue(bogus), null)
})

test('脱敏：JSON 引号键（password/Authorization/token）也必须遮蔽', () => {
  assert.match(sanitizePreview('{"password": "hunter2", "user": "a"}'), /"password":<redacted>/)
  assert.match(sanitizePreview('{"Authorization": "Bearer abcdef"}'), /"authorization":<redacted>/i)
  assert.match(sanitizePreview('curl -H "token: abc123"'), /token=<redacted>/)
  assert.match(sanitizePreview('Authorization: Bearer XYZ'), /Authorization=<redacted>/)
  assert.match(sanitizePreview('https://user:pass@example.com/x'), /<redacted>@/)
  assert.equal(sanitizePreview('x'.repeat(1000)).length <= 301, true)
})

// ---------------------------------------------------------------- grant

test('grant：身份/凭据摘要/版本/租约/续期/撤销/持久重开', async () => {
  const root = tmpRoot()
  const store = openApprovalStore({ root })
  const raw = crypto.randomBytes(32).toString('hex')
  const digest = controlCredDigest(raw)
  const grant = GRANT(store, digest, { authorization: '允许在本项目临时目录做读写验证' })

  assert.equal(grant.status, GRANT_STATES.ACTIVE)
  assert.equal(grant.authorization, '允许在本项目临时目录做读写验证', '授权说明随 grant 固定记录')
  assert.equal(store.validateGrant({ grantId: grant.grantId, taskId: 't-1', originThreadId: 'origin-A', sessionId: 'sess-1', credDigest: digest }).ok, true)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: controlCredDigest('other') }).reason, APPROVAL_REASONS.GRANT_CRED_MISMATCH)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest, originThreadId: 'origin-B' }).reason, APPROVAL_REASONS.ORIGIN_MISMATCH)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest, taskId: 't-2' }).reason, APPROVAL_REASONS.GRANT_SCOPE_MISMATCH)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest, sessionId: 'sess-2' }).reason, APPROVAL_REASONS.GRANT_SCOPE_MISMATCH)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest, grantVersion: 9 }).reason, APPROVAL_REASONS.GRANT_VERSION_MISMATCH)
  assert.equal(store.validateGrant({ grantId: 'grt-none', credDigest: digest }).reason, APPROVAL_REASONS.GRANT_MISSING)

  // 续租：凭据/身份不对不续；租约受绝对 TTL 封顶
  const short = GRANT(store, digest, { ttlMs: 5_000, leaseMs: 600_000, taskId: 't-short' })
  assert.equal(store.renewLease({ grantId: short.grantId, credDigest: controlCredDigest('bad') }).ok, false)
  assert.equal(store.renewLease({ grantId: short.grantId, taskId: 't-short', originThreadId: 'origin-A', sessionId: 'sess-1', credDigest: digest }).grant.leaseUntil, short.expiresAt)

  // 续期（认证）：延长绝对 TTL，封顶 MAX_AUTHORIZED_TTL_MS
  const renewed = store.renewGrant({ grantId: short.grantId, taskId: 't-short', originThreadId: 'origin-A', sessionId: 'sess-1', credDigest: digest, extendSec: 3600 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.grant.expiresAt > short.expiresAt, true)
  assert.ok(renewed.grant.expiresAt <= short.issuedAt + MAX_AUTHORIZED_TTL_MS)
  // 反复续期最终必须封顶在授权窗口内，绝不无限延长
  let last = renewed
  for (let i = 0; i < 12; i++) {
    last = store.renewGrant({ grantId: short.grantId, taskId: 't-short', originThreadId: 'origin-A', sessionId: 'sess-1', credDigest: digest, extendSec: 3600 })
    assert.equal(last.ok, true)
  }
  assert.equal(last.grant.expiresAt, short.issuedAt + MAX_AUTHORIZED_TTL_MS, '续期必须封顶在授权窗口内')

  // listGrants 支持宣称的过滤（root 指出的 grantId 过滤缺失）
  assert.equal(store.listGrants({ grantId: grant.grantId }).length, 1)
  assert.equal(store.listGrants({ grantId: 'grt-x' }).length, 0)
  assert.equal(store.listGrants({ originThreadId: 'origin-A', sessionId: 'sess-1', taskId: 't-1' }).length, 1)

  // 撤销 + 持久重开
  assert.equal(store.revokeGrant(grant.grantId, 'test').ok, true)
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest }).reason, APPROVAL_REASONS.GRANT_REVOKED)
  const reopened = openApprovalStore({ root })
  assert.equal(reopened.getGrant(grant.grantId).status, GRANT_STATES.REVOKED)
  assert.equal(reopened.grantLogHealthy(), true)
})

test('grant：权限记录受损（截断的 revoke / 坏行）必须安全失败，不得沿用旧有效授权', () => {
  const root = tmpRoot()
  const store = openApprovalStore({ root })
  const raw = crypto.randomBytes(32).toString('hex')
  const digest = controlCredDigest(raw)
  const grant = GRANT(store, digest)

  // 截断最后一行（模拟损坏的 revoke 记录）
  const file = path.join(root, 'grants.jsonl')
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.trim().split('\n')
  fs.writeFileSync(file, lines[0].slice(0, Math.floor(lines[0].length / 2)), 'utf8')

  assert.equal(store.grantLogHealthy(), false, '坏行必须被识别')
  assert.equal(store.validateGrant({ grantId: grant.grantId, credDigest: digest }).reason, APPROVAL_REASONS.GRANT_LOG_CORRUPT)
  assert.equal(store.listGrants({}).length, 0, '受损时列表不给旧授权')
  assert.equal(store.revokeGrant(grant.grantId, 'x').reason, APPROVAL_REASONS.GRANT_LOG_CORRUPT)
})

// ---------------------------------------------------------------- 快照与指纹（修正 A）

test('快照：按 (sessionId, callId) 隔离且不可变；turn/step 必须是整数', () => {
  const store = openApprovalStore({ root: tmpRoot() })
  const a = store.snapshotCall({ sessionId: 'sess-A', callId: 'c1', rootCallId: 'c1', name: 'bash', args: { command: 'rm -rf /danger' }, cwd: 'E:/a' })
  const b = store.snapshotCall({ sessionId: 'sess-B', callId: 'c1', rootCallId: 'c1', name: 'bash', args: { command: 'echo safe' }, cwd: 'E:/b' })
  assert.notEqual(a.snapshotId, b.snapshotId)
  assert.equal(store.getSnapshot('sess-A', 'c1').args.command, 'rm -rf /danger', '另一会话同 callId 不得覆盖本会话快照')
  assert.equal(store.getSnapshot('sess-B', 'c1').args.command, 'echo safe')
  assert.equal(store.getSnapshot('sess-C', 'c1'), undefined)

  // 不可变：外部改不动（冻结副本）
  const snap = store.getSnapshot('sess-A', 'c1')
  assert.equal(Object.isFrozen(snap.args), true)
  assert.throws(() => { snap.args.command = 'tampered' }, TypeError)
  assert.equal(store.getSnapshot('sess-A', 'c1').args.command, 'rm -rf /danger')

  // turn/step：两者都要整数，缺一即拒绝（未知不得作为可批准默认值）
  const annotated = store.annotateSnapshot('sess-A', 'c1', { turn: 1, step: 2 })
  assert.notEqual(annotated, null)
  assert.equal(annotated.turn, 1)
  assert.equal(annotated.step, 2)
  const snap2 = store.snapshotCall({ sessionId: 'sess-A', callId: 'c2', name: 'bash', args: {} })
  assert.equal(store.annotateSnapshot('sess-A', 'c2', { turn: 1 }), null, '缺 step 必须拒绝')
  assert.equal(store.annotateSnapshot('sess-A', 'c2', { turn: 1, step: 'x' }), null, '非整数必须拒绝')
  assert.notEqual(store.annotateSnapshot('sess-A', 'c2', { turn: 1, step: 2 }), null)
  assert.equal(snap2.turn, 1)
  assert.equal(snap2.step, 2)
})

test('指纹：绑定 cwd/root/parent/step/turn/参数/task/grant（修正 A/D）', () => {
  const base = { sessionId: 's', callId: 'c', toolName: 'bash', turn: 7, step: 3, rootCallId: 'c', cwd: 'E:/a', args: { command: 'ls' }, taskId: 't-1', grantId: 'g-1' }
  const fp = actionFingerprint(base)
  assert.equal(actionFingerprint({ ...base }), fp)
  assert.equal(actionFingerprint({ ...base, args: { command: 'ls' } }), fp)
  for (const patch of [
    { cwd: 'E:/b' }, { rootCallId: 'parent' }, { step: 4 }, { turn: 8 }, { callId: 'c2' },
    { args: { command: 'ls -la' } }, { taskId: 't-2' }, { grantId: 'g-2' }, { turn: undefined }, { step: undefined },
    { parentKey: 'token:parent-exec-token' },
  ]) {
    assert.notEqual(actionFingerprint({ ...base, ...patch }), fp, '这些字段任一变化都必须改变指纹: ' + JSON.stringify(patch))
  }
  // 归一：没有父执行（undefined）与显式 null 必须等价，且与"有父但不可稳定表达"不同
  assert.equal(actionFingerprint({ ...base, parentKey: null }), fp)
  assert.notEqual(actionFingerprint({ ...base, parentKey: 'unsupported' }), fp)
})

test('完整执行身份：toolName/root/parent/cwd/turn/step 任一变化 → executionId 变化；未知 → null', () => {
  const base = { sessionId: 's', callId: 'c', toolName: 'bash', turn: 7, step: 3, rootCallId: 'c', parentKey: null, cwd: 'E:/a', args: { command: 'ls' } }
  const id = executionIdentityId(base)
  assert.equal(typeof id, 'string')
  assert.equal(executionIdentityId({ ...base }), id)
  assert.equal(executionIdentityId({ ...base, args: { command: 'ls' } }), id, '参数规范化后应稳定')
  for (const patch of [
    { toolName: 'different-tool' }, { rootCallId: 'new-parent-root' }, { parentKey: 'token:t2' },
    { cwd: 'E:/b' }, { step: 2 }, { turn: 8 }, { args: { command: 'rm -rf /x' } }, { callId: 'c2' },
  ]) {
    assert.notEqual(executionIdentityId({ ...base, ...patch }), id, '必须改变身份: ' + JSON.stringify(patch))
  }
  // 未知即 null：cwd 缺 / 工具名缺 / turn·step 非整数 / 父身份存在但不可稳定表达
  assert.equal(executionIdentityId({ ...base, cwd: undefined }), null)
  assert.equal(executionIdentityId({ ...base, toolName: '' }), null)
  assert.equal(executionIdentityId({ ...base, step: undefined }), null)
  assert.equal(executionIdentityId({ ...base, turn: 'x' }), null)
  assert.equal(executionIdentityId({ ...base, parentKey: 'unsupported' }), null, '父身份无法稳定表达 → unsupported')
  assert.equal(executionIdentityId({ ...base, parent: { opaque: true } }), null)
  assert.equal(canonicalParentKey(undefined), null)
  assert.equal(canonicalParentKey({ token: 't1' }), 'token:t1')
  assert.equal(canonicalParentKey('parent-string'), 's:parent-string')
})

// ---------------------------------------------------------------- 官方身份认领（修正 B/F）

test('官方请求身份：必须唯一认领；同 (session,callId) 两次 ask 各自独立 pending', () => {
  const store = openApprovalStore({ root: tmpRoot() })
  const digest = controlCredDigest(crypto.randomBytes(32).toString('hex'))
  const grant = GRANT(store, digest)
  store.observeOfficialAsked({ officialId: 'off-1', sessionId: 'sess-1', toolName: 'bash', callId: 'call-1' })
  store.observeOfficialAsked({ officialId: 'off-2', sessionId: 'sess-1', toolName: 'bash', callId: 'call-1' })
  assert.equal(store.unclaimedAskedFor('sess-1', 'call-1', 'bash').length, 2, '两个未认领 ask 必须都可见（歧义可判定）')

  // 同一次执行（同一快照身份）被两个官方 request 各问一次
  const execution = () => execOf(store, { sessionId: 'sess-1', callId: 'call-1', name: 'bash', args: { command: 'ls' }, cwd: 'E:/w' })
  const p1 = store.openPending({ execution: execution(), grant, askSeq: 1 })
  const p2 = store.openPending({ execution: execution(), grant, askSeq: 2 })
  assert.notEqual(p1, null, '身份完整的执行必须能打开 pending')
  assert.notEqual(p2, null)
  assert.notEqual(p1.approvalKey, p2.approvalKey, '每次官方 ask 独立 pending（不得按 callId 合并）')
  assert.equal(store.askCountFor('sess-1', 'call-1'), 2)

  assert.equal(store.claimOfficialAsk(p1.approvalKey, 'off-1').ok, true)
  assert.equal(store.claimOfficialAsk(p2.approvalKey, 'off-2').ok, true)
  assert.equal(store.claimOfficialAsk(p2.approvalKey, 'off-1').reason, APPROVAL_REASONS.OFFICIAL_AMBIGUOUS, '同一官方 ask 不能被两条 pending 认领')
  assert.equal(store.unclaimedAskedFor('sess-1', 'call-1', 'bash').length, 0)

  // 一次决定只完成一条（当前 turn/step 必须由日志实时给出）
  const decideArgs = {
    originThreadId: 'origin-A', taskId: 't-1', grantId: grant.grantId, credDigest: digest,
    currentTurnStep: { turn: 7, step: 3 },
  }
  const d1 = store.decide({ approvalKey: p1.approvalKey, fingerprint: p1.fingerprint, decision: DECISIONS.APPROVE_ONCE, ...decideArgs })
  assert.equal(d1.ok, true)
  assert.equal(store.getPending(p2.approvalKey).state, APPROVAL_STATES.PENDING, '第二条必须仍然是 pending（绝不被一次决定放行）')
  store.decide({ approvalKey: p2.approvalKey, fingerprint: p2.fingerprint, decision: DECISIONS.APPROVE_ONCE, ...decideArgs })
  assert.equal(store.settleFromOfficial('off-1', 'allowed-once').state, APPROVAL_STATES.CONFIRMED)
  assert.equal(store.settleFromOfficial('off-2', 'allowed-once').state, APPROVAL_STATES.CONFIRMED)
})

test('官方 decided 的 outcome 决定状态：cancelled/rejected/未知都绝不算批准', () => {
  const store = openApprovalStore({ root: tmpRoot() })
  const digest = controlCredDigest(crypto.randomBytes(32).toString('hex'))
  const grant = GRANT(store, digest)
  const mk = (officialId, callId) => {
    store.observeOfficialAsked({ officialId, sessionId: 'sess-1', toolName: 'bash', callId })
    const p = store.openPending({ execution: execOf(store, { callId }), grant })
    store.claimOfficialAsk(p.approvalKey, officialId)
    store.decide({ approvalKey: p.approvalKey, fingerprint: p.fingerprint, decision: DECISIONS.APPROVE_ONCE, originThreadId: 'origin-A', taskId: 't-1', grantId: grant.grantId, credDigest: digest, currentTurnStep: { turn: 7, step: 3 } })
    return p
  }
  const cancelled = mk('off-c', 'c-cancel')
  assert.equal(store.settleFromOfficial('off-c', 'cancelled').state, APPROVAL_STATES.CANCELLED, 'cancelled 可赢过晚到的 allowed-once')
  assert.equal(cancelled.state, APPROVAL_STATES.CANCELLED)
  assert.notEqual(cancelled.state, APPROVAL_STATES.CONFIRMED)

  const rejected = mk('off-r', 'c-reject')
  assert.equal(store.settleFromOfficial('off-r', 'rejected').state, APPROVAL_STATES.REJECTED)
  assert.notEqual(rejected.state, APPROVAL_STATES.CONFIRMED)

  const unknownOutcome = mk('off-u', 'c-unknown')
  assert.equal(store.settleFromOfficial('off-u', 'unavailable').state, APPROVAL_STATES.DECISION_UNKNOWN)

  // 无对应 pending 的 decided → 只记 orphan，不改任何状态
  assert.equal(store.settleFromOfficial('off-x', 'allowed-once').ok, false)
  assert.equal(store.orphanDecided().length, 1)
  assert.equal(store.orphanDecided()[0].officialId, 'off-x')
})

// ---------------------------------------------------------------- 决定（修正 A/D/F）

const fixture = () => {
  const root = tmpRoot()
  const store = openApprovalStore({ root })
  const raw = crypto.randomBytes(32).toString('hex')
  const digest = controlCredDigest(raw)
  const grant = GRANT(store, digest)
  store.observeOfficialAsked({ officialId: 'off-1', sessionId: 'sess-1', toolName: 'bash', callId: 'call-1' })
  const execution = execOf(store, { name: 'bash', args: { command: 'rm -rf /danger' }, cwd: 'E:/work' })
  const snapshot = store.getSnapshot('sess-1', 'call-1')
  const pending = store.openPending({ execution, grant })
  store.claimOfficialAsk(pending.approvalKey, 'off-1')
  const base = {
    approvalKey: pending.approvalKey, fingerprint: pending.fingerprint, decision: DECISIONS.APPROVE_ONCE,
    originThreadId: 'origin-A', taskId: 't-1', grantId: grant.grantId, credDigest: digest,
    currentTurnStep: { turn: 7, step: 3 },
  }
  return { root, store, digest, grant, snapshot, pending, base }
}

test('决定：身份/版本/官方身份/指纹/实时上下文 五重核对 + 审计先行 + 幂等', () => {
  const { store, pending, base, digest } = fixture()

  assert.equal(store.decide({ ...base, originThreadId: undefined }).reason, APPROVAL_REASONS.ORIGIN_REQUIRED)
  assert.equal(store.decide({ ...base, taskId: undefined }).reason, APPROVAL_REASONS.TASK_REQUIRED)
  assert.equal(store.decide({ ...base, originThreadId: 'origin-B' }).reason, APPROVAL_REASONS.ORIGIN_MISMATCH)
  assert.equal(store.decide({ ...base, taskId: 't-2' }).reason, APPROVAL_REASONS.GRANT_SCOPE_MISMATCH)
  assert.equal(store.decide({ ...base, grantVersion: 9 }).reason, APPROVAL_REASONS.GRANT_VERSION_MISMATCH)
  assert.equal(store.decide({ ...base, credDigest: controlCredDigest('bad') }).reason, APPROVAL_REASONS.GRANT_CRED_MISMATCH)
  assert.equal(store.decide({ ...base, fingerprint: 'f'.repeat(64) }).reason, APPROVAL_REASONS.FINGERPRINT_MISMATCH)
  assert.equal(store.decide({ ...base, currentSnapshotId: 'snap-other' }).reason, APPROVAL_REASONS.CONTEXT_CHANGED, '实时快照被替换必须拒绝')
  assert.equal(store.getPending(pending.approvalKey).state, APPROVAL_STATES.PENDING)

  // 未认领官方身份 → 拒绝
  const unbound = fixture()
  unbound.store.claimOfficialAsk(unbound.pending.approvalKey, '')
  const stray = unbound.store.openPending({
    execution: execOf(unbound.store, { sessionId: 'sess-1', callId: 'call-9' }), grant: unbound.grant,
  })
  assert.equal(unbound.store.decide({ ...unbound.base, approvalKey: stray.approvalKey }).reason, APPROVAL_REASONS.OFFICIAL_UNBOUND)

  // 身份不完整（拿不到当前 turn/step）→ **明确 unsupported**，绝不当作可放行
  assert.equal(store.decide({ ...base, currentTurnStep: undefined }).reason, APPROVAL_REASONS.IDENTITY_UNKNOWN)
  assert.equal(store.decide({ ...base, currentTurnStep: { turn: 7 } }).reason, APPROVAL_REASONS.IDENTITY_UNKNOWN)
  assert.equal(store.decide({ ...base, currentTurnStep: { turn: 7, step: 9 } }).reason, APPROVAL_REASONS.CONTEXT_CHANGED, '当前 step 变了 → 代际变化')
  assert.equal(store.getPending(pending.approvalKey).state, APPROVAL_STATES.PENDING, '以上全部拒绝都不得改变状态')

  // 正向 + 幂等
  const before = store.auditCount()
  const ok = store.decide({ ...base, idempotencyKey: 'idem-1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.outcome, 'allowed-once')
  assert.equal(ok.state, APPROVAL_STATES.SUBMITTED)
  assert.equal(store.auditCount(), before + 1, '只写一条 intent 审计')
  const rows = store.readAudit(5)
  const intent = rows.find((r) => r.type === 'decision' && r.phase === 'submitted')
  assert.match(intent.argsSha256, /^[0-9a-f]{64}$/, '审计只落参数摘要')
  assert.equal(intent.argsPreview, undefined, '审计不落任何原文预览')
  assert.equal(JSON.stringify(intent).includes('rm -rf /danger'), false, '审计不落完整危险原文（只留摘要）')
  assert.equal(store.decide({ ...base, idempotencyKey: 'idem-1' }).idempotent, true)
  assert.equal(store.decide({ ...base, idempotencyKey: 'idem-2' }).reason, APPROVAL_REASONS.PENDING_ALREADY_DECIDED)
  assert.equal(digest.includes('rm'), false)
})

test('决定：审计写失败 → fail-closed（不推进状态）', () => {
  const { store, base, pending } = fixture()
  fs.rmSync(store.auditFile, { force: true, recursive: true })
  fs.mkdirSync(store.auditFile, { recursive: true })
  const result = store.decide({ ...base })
  assert.equal(result.ok, false)
  assert.equal(result.reason, APPROVAL_REASONS.AUDIT_WRITE_FAILED)
  assert.equal(store.getPending(pending.approvalKey).state, APPROVAL_STATES.PENDING)
})

test('收口与恢复：运行中活跃项不作为"重启残留"；重启后 submitted→decision-unknown、未决定→unanswerable', () => {
  const { root, store, base, pending } = fixture()
  store.decide({ ...base })
  // 第三轮修正 B：本进程内存里仍有确切状态/有效 callback → **绝不**同时列为 unanswerable
  assert.equal(store.unansweredFromAudit().some((r) => r.approvalKey === pending.approvalKey), false, '运行中不得把活跃项当重启残留')
  // 模拟重启：新实例（无内存 pending）→ submitted 未确认必须明确 decision-unknown
  const reopened = openApprovalStore({ root })
  const row = reopened.unansweredFromAudit().find((r) => r.approvalKey === pending.approvalKey)
  assert.notEqual(row, undefined, '重启后 submitted 未确认不得从恢复视图消失')
  assert.equal(row.state, APPROVAL_STATES.DECISION_UNKNOWN)
  assert.equal(row.live, false)

  // 未决定的 → 重启后 unanswerable；已确认的 → 不再列出
  const second = fixture()
  assert.equal(second.store.unansweredFromAudit().some((r) => r.approvalKey === second.pending.approvalKey), false, '运行中不得列为残留')
  assert.equal(openApprovalStore({ root: second.root }).unansweredFromAudit().find((r) => r.approvalKey === second.pending.approvalKey).state, 'unanswerable')
  second.store.decide({ ...second.base })
  second.store.settleFromOfficial('off-1', 'allowed-once')
  assert.equal(openApprovalStore({ root: second.root }).unansweredFromAudit().some((r) => r.approvalKey === second.pending.approvalKey), false)

  // closeLiveForTask：卸载/撤销时在途项收口
  const third = fixture()
  assert.equal(third.store.liveCountForTask('t-1'), 1)
  assert.equal(third.store.closeLiveForTask('t-1', APPROVAL_STATES.SUPERSEDED, 'unloaded'), 1)
  assert.equal(third.store.liveCountForTask('t-1'), 0)
  assert.equal(third.store.decide({ ...third.base }).reason, APPROVAL_REASONS.PENDING_ALREADY_DECIDED)
})

test('pendingView 只读不可变副本（不回看其它请求的当前快照）', () => {
  const { store, pending } = fixture()
  const view = store.pendingView(pending)
  assert.equal(view.args.command, 'rm -rf /danger')
  assert.equal(view.cwd, 'E:/work')
  assert.equal(view.turn, 7)
  assert.equal(view.step, 3)
  assert.equal(view.officialId, 'off-1')
  // 之后另一会话用同 callId 覆盖快照，视图不受影响
  store.snapshotCall({ sessionId: 'sess-OTHER', callId: 'call-1', name: 'bash', args: { command: 'echo safe' } })
  store.snapshotCall({ sessionId: 'sess-1', callId: 'call-1', name: 'bash', args: { command: 'echo safe' }, cwd: 'E:/work' })
  assert.equal(store.pendingView(pending).args.command, 'rm -rf /danger', '视图必须来自打开时刻的不可变副本')
})
