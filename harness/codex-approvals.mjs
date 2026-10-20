/**
 * codex-approvals.mjs —— 「Codex 接手 DSH 单次审批」核心：控制凭据、任务 grant、不可变执行快照、
 * 官方请求身份认领、单次状态机、幂等、租约/总期限、撤销与最小持久审计。
 *
 * 认证边界（本轮修正 C）：
 *   - 传输的是**私有 raw key**（`X-Dsh-Control`），服务端与本机 key 文件做等值比较；
 *     `sha256(key)` 之类的持久摘要**不再能认证**（它不是 bearer）。
 *   - grant/audit 只存**域分离的单向摘要** `credDigest`（`digest:sha256('dsh-approval-grant-digest:'+key)`），
 *     不能用于登录；raw key 不进工具输入/结果/错误/日志/审计。
 *   - key 读入做格式校验（64 hex），不合规一律视为"无 key"（能力关闭），绝不把任意配置当 header 发出去。
 *
 * 绑定边界（本轮修正 A/B/D）：
 *   - 快照按 `(sessionId, callId)` 存**不可变深拷贝**（含 args/cwd/root/parent/step/turn），
 *     绝不用"当前某 callId 的快照"回看另一个请求；turn/step 必须都是实数，未知不作为可批准默认值。
 *   - pending 持有打开时刻的执行上下文副本；决定时要求**实时快照身份仍等于**该副本（参数/上下文变化即拒绝）。
 *   - 每个官方 `request()`/callback 各自一个独立桥接 pending 与一次性状态；官方 ask 身份（UUID）必须
 *     **唯一认领**（歧义即交人工），一次决定只完成一条。
 *   - 指纹绑定 session/callId/toolName/turn/step/root/parent/cwd/真实参数 + task/grant 身份。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createFileLock } from './fs-lock.mjs'

export const APPROVAL_STATES = {
  PENDING: 'pending',
  SUBMITTED: 'decision-submitted',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
  AMBIGUOUS: 'unsupported-ambiguous',
  CONTEXT_CHANGED: 'context-changed',
  DECISION_UNKNOWN: 'decision-unknown',
}

export const GRANT_STATES = { ACTIVE: 'active', REVOKED: 'revoked', EXPIRED: 'expired' }

export const DECISIONS = { APPROVE_ONCE: 'approve-once', REJECT: 'reject' }
const OUTCOME_FOR = { 'approve-once': 'allowed-once', reject: 'rejected' }

export const APPROVAL_REASONS = {
  NO_KEY: 'approval-key-missing',
  BAD_KEY_FORMAT: 'approval-key-malformed',
  BAD_HEADER: 'approval-control-invalid',
  GRANT_MISSING: 'grant-missing',
  GRANT_REVOKED: 'grant-revoked',
  GRANT_EXPIRED: 'grant-expired',
  GRANT_CRED_MISMATCH: 'grant-cred-mismatch',
  GRANT_SCOPE_MISMATCH: 'grant-scope-mismatch',
  GRANT_VERSION_MISMATCH: 'grant-version-mismatch',
  GRANT_LOG_CORRUPT: 'grant-log-corrupt',
  ORIGIN_REQUIRED: 'origin-required',
  ORIGIN_MISMATCH: 'origin-mismatch',
  TASK_REQUIRED: 'task-required',
  PENDING_MISSING: 'approval-not-found',
  PENDING_ALREADY_DECIDED: 'approval-already-decided',
  PENDING_EXPIRED: 'approval-expired',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  FINGERPRINT_MISMATCH: 'fingerprint-mismatch',
  CONTEXT_CHANGED: 'approval-context-changed',
  IDENTITY_UNKNOWN: 'execution-identity-unknown',
  OFFICIAL_UNBOUND: 'official-request-unbound',
  OFFICIAL_AMBIGUOUS: 'official-request-ambiguous',
  EXTRA_FIELDS: 'unexpected-fields',
  AUDIT_WRITE_FAILED: 'audit-write-failed',
  UNSUPPORTED_TARGET: 'approval-unsupported-target',
  UNSUPPORTED_CALL: 'approval-unsupported-call',
}

const DEFAULT_LEASE_MS = 60_000
const DEFAULT_GRANT_TTL_MS = 15 * 60_000
const MAX_GRANT_TTL_MS = 60 * 60_000
/** 认证续期能延到的绝对上限（相对签发时间），避免"无限续期"变成永久授权。 */
export const MAX_AUTHORIZED_TTL_MS = 8 * 60 * 60_000
const SNAPSHOT_TTL_MS = 10 * 60_000
const SNAPSHOT_MAX = 256
const KEY_PATTERN = /^[0-9a-f]{64}$/

const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex')

export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

// ---------------------------------------------------------------- 控制凭据

export const controlKeyPath = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  if (typeof process.env.DSH_APPROVAL_CONTROL_KEY_PATH === 'string' && process.env.DSH_APPROVAL_CONTROL_KEY_PATH.trim() !== '') {
    return path.resolve(process.env.DSH_APPROVAL_CONTROL_KEY_PATH)
  }
  return path.join(os.homedir(), '.dsh-codex-approval', 'control.key')
}

/** 非认证用途的指纹（域分离，不可反推、也不可当 header 用）。 */
export const keyFingerprint8 = (key) => sha256Hex('dsh-approval-key-fp:' + String(key)).slice(0, 8)

/**
 * grant/audit 里保存的单向摘要：**域分离**，与认证 header 不同域 ⇒ 拿到它也无法登录。
 * （修正 C：以前存 `sha256(rawKey)`，而 header 正是同一个 hash，等于把 bearer 落盘。）
 */
export const controlCredDigest = (key) => 'digest:' + sha256Hex('dsh-approval-grant-digest:' + String(key))

/** 离线原子初始化控制 key（只在不存在时创建；force 才轮换，轮换=撤销全部旧 grant）。 */
export const initControlKey = (options = {}) => {
  const file = controlKeyPath(options.path)
  const force = options.force === true
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, '.key-' + uid('tmp'))
  const raw = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(tmp, raw + '\n', { encoding: 'utf8', mode: 0o600 })
  let rotated = false
  try {
    if (force) {
      fs.renameSync(tmp, file)
      rotated = true
    } else {
      try {
        fs.linkSync(tmp, file)
      } catch (e) {
        if (e !== null && typeof e === 'object' && e.code === 'EEXIST') {
          fs.unlinkSync(tmp)
          throw new Error('control key already exists at ' + file + ' (use explicit rotate to replace it; rotating revokes every existing grant)')
        }
        throw e
      }
      fs.unlinkSync(tmp)
    }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) { /* temp 已转正或已删 */ }
  }
  return { path: file, fp8: keyFingerprint8(raw), rotated }
}

/**
 * 读 key；**格式不合法按"没有 key"处理**（能力关闭）。避免把任意配置/文件内容当 header 发出去。
 * @returns {string|null}
 */
export const readControlKey = (explicitPath) => {
  const file = controlKeyPath(explicitPath)
  let value
  try {
    value = fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    return null
  }
  if (!KEY_PATTERN.test(value)) return null
  return value
}

/** 客户端用：raw key 作为认证 header；无 key/格式不合规 → null（调用方零执行拒绝）。 */
export const controlHeaderValue = (explicitPath) => {
  const key = readControlKey(explicitPath)
  if (key === null) return null
  return { 'X-Dsh-Control': key }
}

/** 服务端用：与 raw key 等值比较（timingSafeEqual，等长前提）。 */
export const verifyControlHeader = (headerValue, key) => {
  if (typeof headerValue !== 'string' || !KEY_PATTERN.test(headerValue)) return false
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return false
  const a = Buffer.from(headerValue, 'utf8')
  const b = Buffer.from(key, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---------------------------------------------------------------- 脱敏摘要

const SECRET_PATTERNS = [
  /\b(authorization|bearer|cookie|password|passwd|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
  /"(authorization|password|passwd|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret)"\s*:\s*"[^"]*"/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g,
]
/** 只用于审计/展示摘要：遮蔽常见凭据形状（含 JSON 引号键），并截断。不是"能去掉所有秘密"的保证。 */
export const sanitizePreview = (text, limit = 300) => {
  let out = typeof text === 'string' ? text.replace(/[\r\n]+/g, ' ') : ''
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match, p1) => (String(match).trimStart().startsWith('"') ? '"' + p1 + '":<redacted>' : p1 + '=<redacted>'))
  out = out.replace(/(https?:\/\/)[^\s@/]+:[^\s@/]+@/g, '$1<redacted>@')
  return out.length > limit ? out.slice(0, limit) + '…' : out
}

/**
 * 审计只保留**可核对的最小身份/摘要**（不落任何原文，包括命令文本）：
 * 动作内容以 argsSha256 呈现，需要看真实参数走**已鉴权的审批详情**（pendingView）。
 */
export const auditActionSummary = (execution) => ({
  toolName: execution.toolName,
  callId: execution.callId,
  turn: execution.turn,
  step: execution.step,
  cwd: execution.cwd,
  argsSha256: sha256Hex(canonicalJson(execution.args)),
})

/** 结构化参数的稳定 JSON（键排序）。 */
export function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}
const deepCopy = (value) => (value === undefined ? undefined : deepFreeze(structuredClone(value)))

/**
 * 官方执行身份里"父调用"的真实形态（已核对本机官方源码，不是杜撰）：
 *   - `tools/pre-execute` 收到的 exec 是 dsh-tools `createExecution()` 构造的 execution 对象：
 *     `{token, callId, rootCallId, name, args, signal, agent?, parent?, schema?}`（dsh-tools/lib/index.js:3143-3168）
 *   - 嵌套/PTC 派发时 `parent` 是**父执行的 token**（dsh-tools/lib/ptc.js:439 `parent: exec.token`）；
 *     顶层执行没有 parent。
 *   - `rootCallId` 由 SDK 归一：顶层 `rootCallId = exec.rootCallId ?? callId`（:3135）。
 *   - **exec 上没有 cwd**：cwd 的真实来源是 `exec.agent.session.header.cwd`（dsh-tools:1423 同一取值路径；
 *     dsh-session:1044-1046 保证它是合法绝对路径字符串）。
 * token 不可序列化，所以父身份只能按"是否存在 + 可序列化的稳定键"参与；**present 但无法稳定表达 → unsupported**。
 */
export const canonicalParentKey = (parent) => {
  if (parent === undefined || parent === null) return null
  if (typeof parent === 'string') return parent === '' ? 'unsupported' : 's:' + parent
  if (typeof parent === 'object') {
    for (const field of ['token', 'callId', 'id', 'name']) {
      const value = parent[field]
      if (typeof value === 'string' && value !== '') return field + ':' + value
    }
    return 'unsupported' // 存在父执行但拿不到稳定身份 → 不许假装完整
  }
  return 'unsupported'
}

/** 身份内容（不含 turn/step）：任一必需项缺失就返回 null（**未知即 unsupported**，绝不当作完整）。 */
export const identityContent = (parts) => {
  const callId = typeof parts.callId === 'string' && parts.callId !== '' ? parts.callId : null
  const sessionId = typeof parts.sessionId === 'string' && parts.sessionId !== '' ? parts.sessionId : null
  const toolName = typeof parts.toolName === 'string' && parts.toolName !== '' ? parts.toolName : null
  const cwd = typeof parts.cwd === 'string' && parts.cwd !== '' ? parts.cwd : null
  // 父身份：只给 parent 就派生；只给 parentKey 就用它；**两者都给且不一致 → unsupported**
  // （否则一个陈旧/伪造的 parentKey=null 可以遮蔽真实存在的 parent，让代际变化不可见）
  const derivedParentKey = canonicalParentKey(parts.parent)
  let parentKey
  if (parts.parentKey === undefined) parentKey = derivedParentKey
  else if (parts.parent === undefined) parentKey = parts.parentKey
  else parentKey = parts.parentKey === derivedParentKey ? parts.parentKey : 'unsupported'
  if (callId === null || sessionId === null || toolName === null || cwd === null) return null
  if (parentKey === 'unsupported') return null
  return {
    sessionId,
    callId,
    rootCallId: typeof parts.rootCallId === 'string' && parts.rootCallId !== '' ? parts.rootCallId : callId,
    parentKey: parentKey === undefined ? null : parentKey,
    toolName,
    cwd,
    argsSha256: sha256Hex(canonicalJson(parts.args)),
  }
}

/** 身份内容 id（toolName/root/parent/cwd/args 任一变化 → 不同）：用于快照"代际"识别。 */
export const contentIdOf = (content) => (content === null ? null : 'cid-' + sha256Hex(JSON.stringify([
  content.sessionId, content.callId, content.rootCallId, content.parentKey, content.toolName, content.cwd, content.argsSha256,
])).slice(0, 24))

/**
 * **完整执行身份** = 身份内容 + 真实 turn/step（都必须是整数）。
 * 任一项未知 → null：调用方必须 `next()`/拒绝（unsupported），不得凭不完整身份放行。
 */
export const executionIdentityId = (parts) => {
  const content = identityContent(parts)
  if (content === null) return null
  const turn = parts.turn
  const step = parts.step
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return null
  return 'xid-' + sha256Hex(JSON.stringify([
    content.sessionId, content.callId, content.rootCallId, content.parentKey, content.toolName,
    content.cwd, content.argsSha256, turn, step,
  ])).slice(0, 32)
}

/**
 * 不可变动作指纹：绑定 session/callId/toolName/turn/step/root/parent/cwd/真实参数 + 授权身份（task/grant）。
 * 这些字段任一变化 → 指纹不同 → 决定被拒（修正 A：cwd/root/parent 参与；D：授权身份参与；
 * 第二轮：parent 用官方真实字段 `exec.parent` 参与，不再只在注释里声称）。
 */
export const actionFingerprint = (parts) => sha256Hex(JSON.stringify([
  parts.sessionId,
  parts.callId,
  parts.toolName,
  typeof parts.turn === 'number' ? parts.turn : 'no-turn',
  typeof parts.step === 'number' ? parts.step : 'no-step',
  parts.rootCallId === undefined ? null : parts.rootCallId,
  parts.parentKey === undefined ? canonicalParentKey(parts.parent) : parts.parentKey,
  parts.cwd === undefined ? null : parts.cwd,
  canonicalJson(parts.args),
  parts.taskId === undefined ? null : parts.taskId,
  parts.grantId === undefined ? null : parts.grantId,
]))

// ---------------------------------------------------------------- 持久存储

export const approvalStoreRoot = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  if (typeof process.env.DSH_APPROVAL_DIR === 'string' && process.env.DSH_APPROVAL_DIR.trim() !== '') return path.resolve(process.env.DSH_APPROVAL_DIR)
  return path.join(os.homedir(), '.dsh-codex-approval')
}

/**
 * JSONL 读取。`strict` 用于**权限记录**：任何不可解析行（含被截断的最后一行）都必须安全失败，
 * 而不是跳过坏行后继续把旧 grant 当有效（修正 F）。
 */
const readJsonl = (file, options = {}) => {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return []
    if (options.strict === true) throw new Error('cannot read ' + file + ': ' + e.message)
    return []
  }
  if (text.trim() === '') return []
  const rows = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch (e) {
      if (options.strict === true) throw new Error(file + ' has an unparseable line ' + (i + 1) + ' — refusing to treat damaged authorization state as valid')
      // 非权限文件（如审计展示）允许跳过坏行
    }
  }
  return rows
}

export const openApprovalStore = (options = {}) => {
  const root = approvalStoreRoot(options.root)
  const dir = root
  const grantsFile = path.join(dir, 'grants.jsonl')
  const auditFile = path.join(dir, 'audit.jsonl')
  const lock = createFileLock({ lockFile: path.join(dir, '.write.lock'), timeoutMs: options.lockTimeoutMs })

  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true }) }

  const appendLine = (file, row) => {
    ensureDir()
    let size = 0
    try { size = fs.statSync(file).size } catch (e) { size = 0 }
    if (size > 0) {
      let last = 0
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(1)
        fs.readSync(fd, buf, 0, 1, size - 1)
        last = buf[0]
      } finally {
        fs.closeSync(fd)
      }
      if (last !== 0x0a) fs.appendFileSync(file, '\n', 'utf8')
    }
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
  }

  const withLock = (fn) => lock.withLock(fn)

  /** 折叠 grant（严格读：坏行 → 抛出让调用方 fail-closed）。 */
  const foldGrants = () => {
    const map = new Map()
    for (const row of readJsonl(grantsFile, { strict: true })) {
      if (row.type === 'grant' && typeof row.grantId === 'string') map.set(row.grantId, row)
      if (row.type === 'grant-update' && typeof row.grantId === 'string') {
        const grant = map.get(row.grantId)
        if (grant === undefined) continue
        if (row.status !== undefined) grant.status = row.status
        if (row.leaseUntil !== undefined) grant.leaseUntil = row.leaseUntil
        if (row.expiresAt !== undefined) grant.expiresAt = row.expiresAt
        if (row.revokedAt !== undefined) grant.revokedAt = row.revokedAt
        if (row.revokeReason !== undefined) grant.revokeReason = row.revokeReason
        if (row.version !== undefined) grant.version = row.version
        if (row.authorization !== undefined) grant.authorization = row.authorization
      }
    }
    return map
  }

  const snapshots = new Map()      // `${sessionId}\u0000${callId}` → 不可变执行快照
  const pendings = new Map()       // approvalKey → pending（每次官方 ask 一条）
  const executionIndex = new Map() // `${sessionId}\u0000${callId}` → [approvalKey...]
  const officialAsks = new Map()   // officialId → {officialId, sessionId, toolName, callId, seenAt, claimedBy?}
  const orphans = []               // 观察到但无对应 pending 的 decided（诊断）

  const snapKey = (sessionId, callId) => sessionId + '\u0000' + callId

  const pruneSnapshots = (now) => {
    for (const [key, snapshot] of snapshots) {
      if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) snapshots.delete(key)
    }
    while (snapshots.size > SNAPSHOT_MAX) snapshots.delete(snapshots.keys().next().value)
  }

  const store = {
    root,
    dir,
    grantsFile,
    auditFile,
    APPROVAL_STATES,

    audit(row) {
      try {
        withLock(() => appendLine(auditFile, { ts: Date.now(), actor: 'codex-delegate', ...row }))
        return true
      } catch (e) {
        console.error('[codex-approvals] audit append failed:', String(e && e.message ? e.message : e).slice(0, 200))
        return false
      }
    },

    // ------------------------------------------------------------ grant

    issueGrant({ originThreadId, taskId, scope, ttlMs, leaseMs, credDigest, authorization }) {
      const now = Date.now()
      const ttl = Math.min(typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS)
      const lease = typeof leaseMs === 'number' && leaseMs > 0 ? leaseMs : DEFAULT_LEASE_MS
      const sessionId = scope !== null && typeof scope === 'object' && typeof scope.sessionId === 'string' ? scope.sessionId : ''
      if (sessionId === '') throw new Error('grant scope requires a sessionId (session-target binding)')
      if (typeof credDigest !== 'string' || !credDigest.startsWith('digest:')) throw new Error('grant requires a domain-separated credential digest (never the raw key or its bare hash)')
      const grant = {
        type: 'grant',
        grantId: uid('grt'),
        version: 1,
        originThreadId,
        taskId,
        scope: { kind: 'session', sessionId },
        // 授权说明/工作范围随 grant 固定记录并回给审批模型；来源必须是可信发起端提供的文本（服务器不解释成策略）。
        authorization: typeof authorization === 'string' ? sanitizePreview(authorization, 500) : undefined,
        credDigest,
        issuedAt: now,
        expiresAt: now + ttl,
        leaseUntil: now + lease,
        leaseMs: lease,
        status: GRANT_STATES.ACTIVE,
        nonce: crypto.randomBytes(8).toString('hex'),
      }
      withLock(() => appendLine(grantsFile, grant))
      return grant
    },

    getGrant(grantId) {
      try {
        return foldGrants().get(grantId)
      } catch (e) {
        return undefined
      }
    },

    /** 列表（支持宣称的过滤；严格读，坏行 → 空 + reason）。 */
    listGrants(filter = {}) {
      let all
      try {
        all = Array.from(foldGrants().values())
      } catch (e) {
        return []
      }
      const out = all.filter((g) => {
        if (filter.grantId !== undefined && g.grantId !== filter.grantId) return false
        if (filter.taskId !== undefined && g.taskId !== filter.taskId) return false
        if (filter.originThreadId !== undefined && g.originThreadId !== filter.originThreadId) return false
        if (filter.sessionId !== undefined && g.scope.sessionId !== filter.sessionId) return false
        if (filter.activeOnly === true && g.status !== GRANT_STATES.ACTIVE) return false
        return true
      })
      out.sort((a, b) => b.issuedAt - a.issuedAt)
      return out
    },

    grantLogHealthy() {
      try {
        foldGrants()
        return true
      } catch (e) {
        return false
      }
    },

    /**
     * 校验 grant：身份（grantId/task/origin/session）+ 凭据摘要 + 版本 + 未撤销 + 绝对 TTL + 租约。
     * `options.ignoreLease` 只给续租用（租约正是要被重置的东西）。
     */
    validateGrant({ grantId, taskId, originThreadId, sessionId, credDigest, grantVersion, now = Date.now() }, opts = {}) {
      let grant
      try {
        grant = foldGrants().get(grantId)
      } catch (e) {
        return { ok: false, reason: APPROVAL_REASONS.GRANT_LOG_CORRUPT }
      }
      if (grant === undefined) return { ok: false, reason: APPROVAL_REASONS.GRANT_MISSING }
      if (grant.status === GRANT_STATES.REVOKED) return { ok: false, reason: APPROVAL_REASONS.GRANT_REVOKED }
      if (now > grant.expiresAt) return { ok: false, reason: APPROVAL_REASONS.GRANT_EXPIRED }
      if (typeof credDigest !== 'string' || credDigest !== grant.credDigest) return { ok: false, reason: APPROVAL_REASONS.GRANT_CRED_MISMATCH }
      if (taskId !== undefined && grant.taskId !== taskId) return { ok: false, reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH }
      if (originThreadId !== undefined && grant.originThreadId !== originThreadId) return { ok: false, reason: APPROVAL_REASONS.ORIGIN_MISMATCH }
      if (sessionId !== undefined && grant.scope.sessionId !== sessionId) return { ok: false, reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH }
      if (grantVersion !== undefined && grantVersion !== grant.version) return { ok: false, reason: APPROVAL_REASONS.GRANT_VERSION_MISMATCH }
      if (opts.ignoreLease !== true && now > grant.leaseUntil) return { ok: false, reason: APPROVAL_REASONS.GRANT_EXPIRED }
      return { ok: true, grant }
    },

    /** 认证续租：延长**租约**（不复活已过的绝对 TTL）。 */
    renewLease({ grantId, taskId, originThreadId, sessionId, credDigest, leaseMs, now = Date.now() }) {
      const check = store.validateGrant({ grantId, taskId, originThreadId, sessionId, credDigest, now }, { ignoreLease: true })
      if (check.ok !== true) return check
      const lease = typeof leaseMs === 'number' && leaseMs > 0 ? leaseMs : (check.grant.leaseMs || DEFAULT_LEASE_MS)
      const leaseUntil = Math.min(now + lease, check.grant.expiresAt)
      try {
        withLock(() => appendLine(grantsFile, { type: 'grant-update', grantId, leaseUntil, at: now }))
      } catch (e) {
        return { ok: false, reason: 'lease-write-failed' }
      }
      return { ok: true, grant: { ...check.grant, leaseUntil } }
    },

    /**
     * 认证续期：在**原授权范围内**显式延长绝对 TTL（封顶 MAX_AUTHORIZED_TTL_MS），并顺带延租约。
     * 这就是"长任务如何显式续期"的官方路径（不靠后台无限续租）。
     */
    renewGrant({ grantId, taskId, originThreadId, sessionId, credDigest, extendSec, now = Date.now() }) {
      const check = store.validateGrant({ grantId, taskId, originThreadId, sessionId, credDigest, now }, { ignoreLease: true })
      if (check.ok !== true) return check
      const grant = check.grant
      const cap = grant.issuedAt + MAX_AUTHORIZED_TTL_MS
      const extendMs = typeof extendSec === 'number' && extendSec > 0 ? Math.min(extendSec, 3600) * 1000 : grant.leaseMs || DEFAULT_LEASE_MS
      // 从**当前有效期**起延长（不是每次重置成 now+extend），并封顶在授权窗口内。
      const expiresAt = Math.min(grant.expiresAt + extendMs, cap)
      const leaseMs = grant.leaseMs || DEFAULT_LEASE_MS
      const leaseUntil = Math.min(now + leaseMs, expiresAt)
      try {
        withLock(() => appendLine(grantsFile, { type: 'grant-update', grantId, expiresAt, leaseUntil, at: now }))
      } catch (e) {
        return { ok: false, reason: 'renew-write-failed' }
      }
      return { ok: true, grant: { ...grant, expiresAt, leaseUntil }, cap }
    },

    revokeGrant(grantId, reason) {
      let grant
      try {
        grant = foldGrants().get(grantId)
      } catch (e) {
        return { ok: false, reason: APPROVAL_REASONS.GRANT_LOG_CORRUPT }
      }
      if (grant === undefined) return { ok: false, reason: APPROVAL_REASONS.GRANT_MISSING }
      if (grant.status === GRANT_STATES.REVOKED) return { ok: true, grant }
      withLock(() => appendLine(grantsFile, { type: 'grant-update', grantId, status: GRANT_STATES.REVOKED, revokedAt: Date.now(), revokeReason: String(reason || 'revoked').slice(0, 200) }))
      for (const pending of pendings.values()) {
        if (pending.grantId === grantId && pending.state === APPROVAL_STATES.PENDING) pending.state = APPROVAL_STATES.SUPERSEDED
      }
      return { ok: true, grant: store.getGrant(grantId) }
    },

    // ------------------------------------------------------------ 不可变执行快照

    /**
     * 记录执行快照：按 (sessionId, callId) 存**深拷贝冻结**的 args（修正 A：全局 callId 会串会话）。
     * 第二轮修正：同时冻结**完整执行身份的可见部分**——toolName / rootCallId / parentKey / cwd(cwdSource)——
     * `snapshotId` 覆盖这些内容，因此 tool-only / root-only / parent-only 变化都会换 id；
     * turn/step 只能由 annotateSnapshot 以实数写入（未知不得作为可批准默认值）。
     */
    snapshotCall({ sessionId, callId, rootCallId, parent, parentKey, name, args, cwd, cwdSource, now = Date.now() }) {
      pruneSnapshots(now)
      if (typeof sessionId !== 'string' || sessionId === '' || typeof callId !== 'string' || callId === '') return null
      const frozenArgs = deepCopy(args)
      const content = identityContent({
        sessionId, callId, rootCallId, toolName: name, cwd, args: frozenArgs,
        parentKey: parentKey === undefined ? canonicalParentKey(parent) : parentKey,
      })
      const snapshot = {
        snapshotId: contentIdOf(content) === null
          ? 'cid-unknown:' + sha256Hex(sessionId + '\u0000' + callId).slice(0, 12)
          : contentIdOf(content),
        sessionId,
        callId,
        rootCallId: content === null ? (typeof rootCallId === 'string' ? rootCallId : undefined) : content.rootCallId,
        parentKey: content === null ? 'unsupported' : content.parentKey,
        name: typeof name === 'string' ? name : '',
        cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
        cwdSource: typeof cwdSource === 'string' ? cwdSource : undefined,
        args: frozenArgs,
        argsSha256: content === null ? null : content.argsSha256,
        identityComplete: content !== null,
        turn: undefined,
        step: undefined,
        turnSource: undefined,
        stepSource: undefined,
        createdAt: now,
        source: 'pre-execute',
      }
      snapshots.set(snapKey(sessionId, callId), snapshot)
      return snapshot
    },

    getSnapshot(sessionId, callId) {
      return snapshots.get(snapKey(sessionId, callId))
    },

    /** 写入 turn/step：两者都必须是整数，否则拒绝（返回 null）；同时固化**完整执行身份**。 */
    annotateSnapshot(sessionId, callId, patch) {
      const snapshot = snapshots.get(snapKey(sessionId, callId))
      if (snapshot === undefined) return null
      const turn = patch !== null && typeof patch === 'object' ? patch.turn : undefined
      const step = patch !== null && typeof patch === 'object' ? patch.step : undefined
      if (!Number.isInteger(turn) || !Number.isInteger(step)) return null
      snapshot.turn = turn
      snapshot.step = step
      snapshot.turnSource = typeof patch.turnSource === 'string' ? patch.turnSource : 'log'
      snapshot.stepSource = typeof patch.stepSource === 'string' ? patch.stepSource : 'log'
      snapshot.executionId = this.executionIdentity(snapshot, { turn, step })
      return snapshot
    },

    /** 由快照 + 给定 turn/step 求完整执行身份（null = 身份不完整/未知）。 */
    executionIdentity(snapshot, turnStep) {
      if (snapshot === undefined || snapshot === null) return null
      return executionIdentityId({
        sessionId: snapshot.sessionId,
        callId: snapshot.callId,
        rootCallId: snapshot.rootCallId,
        parentKey: snapshot.parentKey,
        toolName: snapshot.name,
        cwd: snapshot.cwd,
        args: snapshot.args,
        turn: turnStep === undefined || turnStep === null ? snapshot.turn : turnStep.turn,
        step: turnStep === undefined || turnStep === null ? snapshot.step : turnStep.step,
      })
    },

    // ------------------------------------------------------------ 官方请求身份认领

    /** 观测官方 approval/asked：建立 officialId → (session, toolName, callId) 台账。 */
    observeOfficialAsked({ officialId, sessionId, toolName, callId, seenAt = Date.now() }) {
      if (typeof officialId !== 'string' || officialId === '') return null
      const existing = officialAsks.get(officialId)
      if (existing !== undefined) return existing
      const row = {
        officialId,
        sessionId,
        toolName: typeof toolName === 'string' ? toolName : '',
        callId: typeof callId === 'string' ? callId : undefined,
        seenAt,
        claimedBy: undefined,
      }
      officialAsks.set(officialId, row)
      return row
    },

    /** 仍未认领的候选（用于"唯一认领"判定；绝不按最后/第一条近似匹配）。 */
    unclaimedAskedFor(sessionId, callId, toolName) {
      const out = []
      for (const row of officialAsks.values()) {
        if (row.claimedBy !== undefined) continue
        if (row.sessionId !== sessionId) continue
        if (row.callId !== callId) continue
        if (row.toolName !== toolName) continue
        out.push(row)
      }
      out.sort((a, b) => a.seenAt - b.seenAt)
      return out
    },

    /** 把某个官方 ask 唯一认领给某条桥接 pending；已被认领则失败。 */
    claimOfficialAsk(approvalKey, officialId) {
      const row = officialAsks.get(officialId)
      const pending = pendings.get(approvalKey)
      if (row === undefined || pending === undefined) return { ok: false, reason: APPROVAL_REASONS.OFFICIAL_UNBOUND }
      if (row.claimedBy !== undefined && row.claimedBy !== approvalKey) return { ok: false, reason: APPROVAL_REASONS.OFFICIAL_AMBIGUOUS }
      row.claimedBy = approvalKey
      pending.officialId = officialId
      return { ok: true }
    },

    // ------------------------------------------------------------ pending

    /**
     * 每次官方 ask 一条独立 pending（修正 B：不再按 session+callId 合并）。
     * 执行上下文在打开时刻**深拷贝冻结**，展示与决定只看它（修正 A）。
     */
    openPending({ execution, grant, reason, displayReason, askSeq = 1, now = Date.now() }) {
      const frozen = deepCopy(execution)
      // **身份不完整一律拒绝打开**（未知 cwd/工具/父身份/turn·step → unsupported，不许假装完整）
      const frozenIdentity = executionIdentityId({
        sessionId: frozen.sessionId,
        callId: frozen.callId,
        rootCallId: frozen.rootCallId,
        parentKey: frozen.parentKey,
        toolName: frozen.toolName,
        cwd: frozen.cwd,
        args: frozen.args,
        turn: frozen.turn,
        step: frozen.step,
      })
      if (frozenIdentity === null) return null
      if (contentIdOf(identityContent({
        sessionId: frozen.sessionId, callId: frozen.callId, rootCallId: frozen.rootCallId,
        parentKey: frozen.parentKey, toolName: frozen.toolName, cwd: frozen.cwd, args: frozen.args,
      })) !== frozen.snapshotId) {
        // 快照内容与打开时刻传入的执行身份必须一致（接线错误/陈旧快照 → 拒绝，不猜）
        return null
      }
      const pending = {
        approvalKey: uid('apk'),
        execution: frozen,
        snapshotId: frozen.snapshotId,
        executionId: frozenIdentity,
        fingerprint: actionFingerprint({
          sessionId: frozen.sessionId,
          callId: frozen.callId,
          toolName: frozen.toolName,
          turn: frozen.turn,
          step: frozen.step,
          rootCallId: frozen.rootCallId,
          parentKey: frozen.parentKey,
          cwd: frozen.cwd,
          args: frozen.args,
          taskId: grant.taskId,
          grantId: grant.grantId,
        }),
        grantId: grant.grantId,
        grantVersion: grant.version,
        taskId: grant.taskId,
        originThreadId: grant.originThreadId,
        authorization: grant.authorization,
        sessionId: frozen.sessionId,
        callId: frozen.callId,
        toolName: frozen.toolName,
        reason: typeof reason === 'string' ? sanitizePreview(reason, 300) : undefined,
        displayReason: typeof displayReason === 'object' && displayReason !== null ? displayReason : undefined,
        officialId: undefined,
        askSeq,
        state: APPROVAL_STATES.PENDING,
        createdAt: now,
        expiresAt: Math.min(grant.expiresAt, grant.leaseUntil),
        decision: undefined,
        outcome: undefined,
        decidedAt: undefined,
        confirmedOutcome: undefined,
        idempotencyKey: undefined,
        note: undefined,
      }
      pendings.set(pending.approvalKey, pending)
      const indexKey = snapKey(pending.sessionId, pending.callId)
      const list = executionIndex.get(indexKey) || []
      list.push(pending.approvalKey)
      executionIndex.set(indexKey, list)
      store.audit({
        type: 'approval', phase: 'open', approvalKey: pending.approvalKey, grantId: pending.grantId, taskId: pending.taskId,
        originThreadId: pending.originThreadId, sessionId: pending.sessionId, callId: pending.callId,
        toolName: pending.toolName, turn: frozen.turn, step: frozen.step, cwd: frozen.cwd,
        snapshotId: pending.snapshotId, fingerprint: pending.fingerprint, askSeq,
        officialId: pending.officialId,
        ...auditActionSummary(frozen),
      })
      return pending
    },

    getPending(approvalKey) {
      return pendings.get(approvalKey)
    },

    /** 同 (session, callId) 的 ask 次数（用于多 ask 场景顺序与歧义判断）。 */
    askCountFor(sessionId, callId) {
      const list = executionIndex.get(snapKey(sessionId, callId))
      return Array.isArray(list) ? list.length : 0
    },

    /** 展示视图：**只从 pending 的不可变副本读**，绝不回看其它请求的当前 snapshot（修正 A）。 */
    pendingView(p) {
      const g = store.getGrant(p.grantId)
      return {
        approvalKey: p.approvalKey,
        state: p.state,
        sessionId: p.sessionId,
        callId: p.callId,
        toolName: p.toolName,
        reason: p.reason,
        displayReason: p.displayReason,
        args: p.execution.args,
        cwd: p.execution.cwd,
        turn: p.execution.turn,
        step: p.execution.step,
        turnSource: p.execution.turnSource,
        stepSource: p.execution.stepSource,
        rootCallId: p.execution.rootCallId,
        parentKey: p.execution.parentKey === undefined ? null : p.execution.parentKey,
        cwdSource: p.execution.cwdSource,
        snapshotId: p.snapshotId,
        // 完整执行身份（第二轮）：toolName/root/parent/cwd/args + turn/step 全部参与；
        // 能打开 pending 就意味着身份完整（openPending 对不完整身份直接拒绝），故以 executionId 为准。
        executionId: p.executionId,
        identityComplete: p.executionId !== undefined,
        identity: {
          toolName: p.execution.toolName,
          callId: p.execution.callId,
          rootCallId: p.execution.rootCallId,
          parentKey: p.execution.parentKey === undefined ? null : p.execution.parentKey,
          cwd: p.execution.cwd,
          cwdSource: p.execution.cwdSource,
          turn: p.execution.turn,
          step: p.execution.step,
          argsSha256: sha256Hex(canonicalJson(p.execution.args)),
        },
        argsSha256: sha256Hex(canonicalJson(p.execution.args)),
        fingerprint: p.fingerprint,
        grantId: p.grantId,
        grantVersion: p.grantVersion,
        taskId: p.taskId,
        originThreadId: p.originThreadId,
        authorization: p.authorization,
        askSeq: p.askSeq,
        officialId: p.officialId,
        live: p.state === APPROVAL_STATES.PENDING,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        ...(p.decision === undefined ? {} : { decision: p.decision, outcome: p.outcome, decidedAt: p.decidedAt }),
        ...(p.confirmedOutcome === undefined ? {} : { confirmedOutcome: p.confirmedOutcome }),
        ...(p.note === undefined ? {} : { note: p.note }),
        ...(g === undefined ? {} : { grant: { status: g.status, version: g.version, issuedAt: g.issuedAt, expiresAt: g.expiresAt, leaseUntil: g.leaseUntil } }),
      }
    },

    /** 清单：必须显式给 origin（可再叠加 task/session/grant）——不给就空，绝不跨来源泄露。 */
    listPending(filter = {}) {
      const out = []
      for (const p of pendings.values()) {
        if (filter.approvalKey !== undefined && p.approvalKey !== filter.approvalKey) continue
        if (filter.originThreadId !== undefined && p.originThreadId !== filter.originThreadId) continue
        if (filter.taskId !== undefined && p.taskId !== filter.taskId) continue
        if (filter.sessionId !== undefined && p.sessionId !== filter.sessionId) continue
        if (filter.grantId !== undefined && p.grantId !== filter.grantId) continue
        out.push(p)
      }
      out.sort((a, b) => a.createdAt - b.createdAt)
      return out
    },

    /** 该 task 是否还有未决 pending（用于"并发时不能先把 task 设 running"）。 */
    liveCountForTask(taskId) {
      let count = 0
      for (const p of pendings.values()) {
        if (p.taskId === taskId && p.state === APPROVAL_STATES.PENDING) count++
      }
      return count
    },

    /**
     * 一次性决定（修正 A/B/C/D/F）：
     *   身份（origin/task/grant/version）+ 凭据摘要 + 租约/绝对 TTL + 官方身份已唯一认领
     *   + **实时快照身份仍等于** pending 的不可变副本 + 指纹一致 + 审计 intent 先行。
     */
    decide({ approvalKey, fingerprint, decision, idempotencyKey, credDigest, originThreadId, taskId, grantVersion, currentSnapshotId, currentTurnStep, now = Date.now() }) {
      const pending = pendings.get(approvalKey)
      if (pending === undefined) return { ok: false, reason: APPROVAL_REASONS.PENDING_MISSING }
      const outcome = OUTCOME_FOR[decision]
      if (outcome === undefined) return { ok: false, reason: 'unknown-decision' }

      if (pending.state !== APPROVAL_STATES.PENDING) {
        if (typeof idempotencyKey === 'string' && idempotencyKey !== '' && pending.idempotencyKey === idempotencyKey) {
          if (pending.decision === decision) return { ok: true, state: pending.state, outcome: pending.outcome, idempotent: true }
          return { ok: false, reason: APPROVAL_REASONS.IDEMPOTENCY_CONFLICT }
        }
        return { ok: false, reason: APPROVAL_REASONS.PENDING_ALREADY_DECIDED, state: pending.state }
      }

      if (originThreadId === undefined || taskId === undefined) return { ok: false, reason: originThreadId === undefined ? APPROVAL_REASONS.ORIGIN_REQUIRED : APPROVAL_REASONS.TASK_REQUIRED }
      if (originThreadId !== pending.originThreadId) return { ok: false, reason: APPROVAL_REASONS.ORIGIN_MISMATCH }
      if (taskId !== pending.taskId) return { ok: false, reason: APPROVAL_REASONS.GRANT_SCOPE_MISMATCH }
      if (grantVersion !== undefined && grantVersion !== pending.grantVersion) return { ok: false, reason: APPROVAL_REASONS.GRANT_VERSION_MISMATCH }
      if (typeof pending.officialId !== 'string' || pending.officialId === '') return { ok: false, reason: APPROVAL_REASONS.OFFICIAL_UNBOUND }

      const check = store.validateGrant({
        grantId: pending.grantId, taskId: pending.taskId, originThreadId: pending.originThreadId,
        sessionId: pending.sessionId, credDigest, grantVersion: pending.grantVersion, now,
      }, { ignoreLease: true })
      if (check.ok !== true) return { ok: false, reason: check.reason }

      const windowEnd = Math.min(check.grant.expiresAt, check.grant.leaseUntil)
      if (now > windowEnd) {
        pending.state = APPROVAL_STATES.EXPIRED
        pending.note = 'grant lease/window expired before a decision arrived'
        store.audit({ type: 'decision', phase: 'expired', approvalKey, grantId: pending.grantId, taskId: pending.taskId })
        return { ok: false, reason: APPROVAL_REASONS.PENDING_EXPIRED }
      }

      // 实时执行身份必须是**同一个**（第二轮修正）：完整身份 = toolName/root/parent/cwd/args + 当前日志 turn/step。
      // 只比 coarse snapshotId 不够——root-only / tool-only / **step-only（仅日志新 tool/call）** 都必须被识别。
      const live = store.getSnapshot(pending.sessionId, pending.callId)
      if (live === undefined) return { ok: false, reason: APPROVAL_REASONS.CONTEXT_CHANGED }
      if (currentSnapshotId !== undefined && currentSnapshotId !== pending.snapshotId) {
        return { ok: false, reason: APPROVAL_REASONS.CONTEXT_CHANGED }
      }
      if (live.snapshotId !== pending.snapshotId) return { ok: false, reason: APPROVAL_REASONS.CONTEXT_CHANGED }
      if (live.identityComplete !== true) return { ok: false, reason: APPROVAL_REASONS.IDENTITY_UNKNOWN }
      const turn = currentTurnStep !== null && typeof currentTurnStep === 'object' ? currentTurnStep.turn : undefined
      const step = currentTurnStep !== null && typeof currentTurnStep === 'object' ? currentTurnStep.step : undefined
      if (!Number.isInteger(turn) || !Number.isInteger(step)) {
        // 拿不到当前 turn/step（日志不可读/无 tool/call）→ 明确 unsupported，不猜、不放行
        return { ok: false, reason: APPROVAL_REASONS.IDENTITY_UNKNOWN }
      }
      const liveIdentity = store.executionIdentity(live, { turn, step })
      if (liveIdentity === null) return { ok: false, reason: APPROVAL_REASONS.IDENTITY_UNKNOWN }
      if (liveIdentity !== pending.executionId) return { ok: false, reason: APPROVAL_REASONS.CONTEXT_CHANGED }

      if (typeof fingerprint !== 'string' || fingerprint !== pending.fingerprint) {
        return { ok: false, reason: APPROVAL_REASONS.FINGERPRINT_MISMATCH }
      }

      const intentOk = store.audit({
        type: 'decision', phase: 'submitted', approvalKey, grantId: pending.grantId, grantVersion: pending.grantVersion,
        taskId: pending.taskId, originThreadId: pending.originThreadId, sessionId: pending.sessionId,
        callId: pending.callId, toolName: pending.toolName, decision, fingerprint: pending.fingerprint,
        officialId: pending.officialId, snapshotId: pending.snapshotId,
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        credDigest: typeof credDigest === 'string' ? credDigest.slice(0, 24) : undefined,
        ...auditActionSummary(pending.execution),
      })
      if (!intentOk) return { ok: false, reason: APPROVAL_REASONS.AUDIT_WRITE_FAILED }

      pending.state = APPROVAL_STATES.SUBMITTED
      pending.decision = decision
      pending.outcome = outcome
      pending.idempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey : undefined
      pending.decidedAt = now
      return { ok: true, state: pending.state, outcome, approvalKey }
    },

    /**
     * 官方 approval/decided 观测 → 按**具体 officialId** 收敛；outcome 决定状态（修正 F）：
     * allowed-once → confirmed；cancelled → cancelled；rejected → rejected；其它 → decision-unknown。
     * 绝不因"我们返回过 allowed-once"就记 confirmed，也绝不把 cancelled/rejected 记成批准。
     */
    settleFromOfficial(officialId, officialOutcome) {
      let target
      for (const p of pendings.values()) {
        if (p.officialId === officialId) { target = p; break }
      }
      if (target === undefined) {
        orphans.push({ officialId, officialOutcome, at: Date.now() })
        return { ok: false, reason: APPROVAL_REASONS.PENDING_MISSING }
      }
      if (officialOutcome === 'allowed-once') {
        if (target.state === APPROVAL_STATES.CONFIRMED) return { ok: true, state: target.state, idempotent: true }
        if (target.state !== APPROVAL_STATES.SUBMITTED) return { ok: false, reason: APPROVAL_REASONS.PENDING_ALREADY_DECIDED, state: target.state }
        target.state = APPROVAL_STATES.CONFIRMED
        target.confirmedOutcome = officialOutcome
        store.audit({ type: 'decision', phase: 'confirmed', approvalKey: target.approvalKey, grantId: target.grantId, taskId: target.taskId, officialId, outcome: officialOutcome })
        return { ok: true, state: target.state }
      }
      // cancelled 可以赢过晚到的 allowed-once；rejected 亦然——都不算批准
      const mapped = officialOutcome === 'cancelled' ? APPROVAL_STATES.CANCELLED
        : officialOutcome === 'rejected' ? APPROVAL_STATES.REJECTED
          : APPROVAL_STATES.DECISION_UNKNOWN
      if (target.state === mapped) return { ok: true, state: target.state, idempotent: true }
      target.state = mapped
      target.confirmedOutcome = officialOutcome
      target.note = 'official outcome=' + String(officialOutcome)
      store.audit({ type: 'decision', phase: mapped, approvalKey: target.approvalKey, grantId: target.grantId, taskId: target.taskId, officialId, outcome: officialOutcome })
      return { ok: true, state: target.state }
    },

    markDecisionUnknown(approvalKey, why) {
      const pending = pendings.get(approvalKey)
      if (pending === undefined) return { ok: false, reason: APPROVAL_REASONS.PENDING_MISSING }
      if (pending.state !== APPROVAL_STATES.SUBMITTED) return { ok: true, state: pending.state, idempotent: true }
      pending.state = APPROVAL_STATES.DECISION_UNKNOWN
      pending.note = typeof why === 'string' ? sanitizePreview(why, 200) : 'decision confirmation lost'
      store.audit({ type: 'decision', phase: 'unknown', approvalKey, grantId: pending.grantId, taskId: pending.taskId })
      return { ok: true, state: pending.state }
    },

    /** 收口（交还人工/上下文变化/取消/卸载）。只会动 PENDING 的项。 */
    closePending(approvalKey, state, note) {
      const pending = pendings.get(approvalKey)
      if (pending === undefined) return { ok: false, reason: APPROVAL_REASONS.PENDING_MISSING }
      if (pending.state !== APPROVAL_STATES.PENDING) return { ok: true, state: pending.state, idempotent: true }
      pending.state = state
      pending.note = typeof note === 'string' ? sanitizePreview(note, 200) : undefined
      store.audit({ type: 'decision', phase: state, approvalKey, grantId: pending.grantId, taskId: pending.taskId, note: pending.note })
      return { ok: true, state }
    },

    /** 卸载/撤销时把该 task（或全部）在途挂起项安全收口。 */
    closeLiveForTask(taskId, state, note) {
      let closed = 0
      for (const p of pendings.values()) {
        if (taskId !== undefined && p.taskId !== taskId) continue
        if (p.state !== APPROVAL_STATES.PENDING) continue
        store.closePending(p.approvalKey, state, note)
        closed++
      }
      return closed
    },

    /** 决定已提交但未确认的（供重启/收口时显式标 unknown）。 */
    submittedKeys() {
      const out = []
      for (const p of pendings.values()) if (p.state === APPROVAL_STATES.SUBMITTED) out.push(p.approvalKey)
      return out
    },

    /**
     * 重启/恢复视图（修正 F）：审计里 open 过但状态未定的项必须**明确**出现，不能静默消失：
     *   - 有 submitted 无 confirmed → decision-unknown / live:false
     *   - 无决定记录 → unanswerable / live:false
     *   - confirmed/终态 → 不再列出
     */
    unansweredFromAudit() {
      const rows = readJsonl(auditFile)
      const opened = new Map()
      const decided = new Map()
      for (const row of rows) {
        if (row.type === 'approval' && row.phase === 'open' && typeof row.approvalKey === 'string') opened.set(row.approvalKey, row)
        if (row.type === 'decision' && typeof row.approvalKey === 'string') {
          const list = decided.get(row.approvalKey) || []
          list.push(row)
          decided.set(row.approvalKey, list)
        }
      }
      const out = []
      for (const [approvalKey, row] of opened) {
        // 第三轮修正：**本进程内存里仍有确切状态/有效 callback 的同一条绝不列为"重启残留"**
        // （真实 MCP 输出曾把同一个 pending 同时列进 approvals(live:true) 和 unanswerable）。
        // 只有真正丢过 callback 的记录（重启后新 store 里没有该 pending）才进入恢复视图。
        if (pendings.has(approvalKey)) continue
        const history = decided.get(approvalKey) || []
        const phases = history.map((r) => r.phase)
        if (phases.some((p) => ['confirmed', 'rejected', 'cancelled', 'expired', 'context-changed', 'unsupported-ambiguous'].includes(p))) continue
        const submitted = phases.includes('submitted')
        out.push({
          approvalKey,
          sessionId: row.sessionId,
          callId: row.callId,
          toolName: row.toolName,
          taskId: row.taskId,
          originThreadId: row.originThreadId,
          live: false,
          state: submitted ? APPROVAL_STATES.DECISION_UNKNOWN : 'unanswerable',
          note: submitted
            ? 'submitted but no official approval/decided was observed — confirmation unknown; do not re-send an approval'
            : 'no live callback after restart — cannot approve; wait for a fresh official request or human action',
        })
      }
      return out
    },

    readAudit(limit = 50) {
      const rows = readJsonl(auditFile)
      return rows.slice(-limit).reverse()
    },

    auditCount() {
      return readJsonl(auditFile).length
    },

    /** 测试/诊断：当前在内存里的 pending 数。 */
    liveCount() {
      return pendings.size
    },

    orphanDecided() {
      return orphans.slice()
    },
  }

  return store
}
