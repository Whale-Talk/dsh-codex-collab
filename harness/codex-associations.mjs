/**
 * codex-associations.mjs —— 「来源 Codex 对话 → 任务 → 执行方 DSH」的持久关联记录（零依赖）。
 *
 * 目的（R1）：Codex 在**某个回合**派活时带上来源对话 ID（originThreadId），此后**任何回合**都能
 * 用 originThreadId + taskId 精确取回这次任务的结果；只给 originThreadId 时能列出该对话登记过的任务，
 * 用来找回丢失的 taskId。
 *
 * 存储：`<root>/<namespace>/bindings.jsonl`，**追加型事件日志**（bind / update 各一行），读取时折叠成记录。
 *   - 追加前修记录边界（末字节不是换行就先补一个），残尾不会吞掉后续写入；
 *   - 写入在 fs-lock.mjs 的独占写锁内串行化（与收件箱共用同一把锁的算法）；
 *   - 读不动（权限/IO）抛 store-unreadable；文件有内容但一行都解析不出抛 store-corrupt——
 *     **绝不静默降级成空记录**。
 *
 * 隔离：命名空间是**校验过的短标识**（`[A-Za-z0-9._-]{1,64}`），只用来选子目录；origin/taskId
 * 永远不参与路径拼接。多个网关共用同一命名空间也是安全的：日志是追加型、taskId 全局唯一，
 * 不存在"别人覆盖我的记录"；需要按 profile 分隔时用 DSH_CODEX_TASK_ASSOC_NAMESPACE 指定。
 *
 * 注意：originThreadId 是**关联元数据**，不是认证/授权凭据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileLock } from './fs-lock.mjs'

export const ASSOC_REASONS = {
  /** originThreadId 不是合法的非空字符串。 */
  INVALID_ORIGIN: 'invalid-origin',
  /** 需要来源才能精确取值/恢复，但调用方没给。 */
  MISSING_ORIGIN: 'origin-required',
  /** 给了来源，但这条任务的登记来源不是它——**绝不返回别的对话的结果**。 */
  ORIGIN_MISMATCH: 'origin-mismatch',
  /** taskId 没有关联登记。 */
  UNKNOWN_TASK: 'unknown-task',
  /** 同一 taskId 试图改投另一个来源。 */
  ORIGIN_CONFLICT: 'origin-conflict',
  STORE_UNREADABLE: 'store-unreadable',
  STORE_CORRUPT: 'store-corrupt',
}

export const MAX_ORIGIN_LENGTH = 200
const NAMESPACE_RE = /^[A-Za-z0-9._-]{1,64}$/

/** origin 必须是**非空**字符串（去空白后仍非空）、不含控制字符、长度有界。 */
export const isValidOrigin = (value) => typeof value === 'string'
  && value.trim() !== ''
  && value.trim().length <= MAX_ORIGIN_LENGTH
  && !/[\u0000-\u001f\u007f]/.test(value)

/** 命名空间只允许 `[A-Za-z0-9._-]{1,64}`，且显式排除 `.` / `..`（它们会让 path.join 逃出存储根）。 */
export const isValidNamespace = (value) => typeof value === 'string'
  && NAMESPACE_RE.test(value)
  && value !== '.'
  && value !== '..'

/** 存储根：显式参数 > DSH_CODEX_TASK_ASSOC_DIR > 用户数据目录（**绝不默认写进仓库**）。 */
export const resolveAssocRoot = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  const fromEnv = process.env.DSH_CODEX_TASK_ASSOC_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh-codex-task-assoc')
}

/** 命名空间：显式参数 > 环境变量 > 'default'。非法命名空间直接抛错（不拼路径）。 */
export const resolveNamespace = (explicit) => {
  const raw = (typeof explicit === 'string' && explicit.trim() !== '')
    ? explicit.trim()
    : (typeof process.env.DSH_CODEX_TASK_ASSOC_NAMESPACE === 'string' && process.env.DSH_CODEX_TASK_ASSOC_NAMESPACE.trim() !== ''
        ? process.env.DSH_CODEX_TASK_ASSOC_NAMESPACE.trim()
        : 'default')
  if (!isValidNamespace(raw)) {
    throw Object.assign(new Error('invalid association namespace: ' + JSON.stringify(raw) + ' (expected [A-Za-z0-9._-]{1,64})'), { reason: ASSOC_REASONS.INVALID_ORIGIN })
  }
  return raw
}

const fail = (reason, message, extra) => Object.assign(new Error(message), { reason, ...(extra === undefined ? {} : extra) })

const readJsonLines = (file) => {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return []
    throw fail(ASSOC_REASONS.STORE_UNREADABLE, 'cannot read ' + file + ': ' + e.message)
  }
  if (text.trim() === '') return []
  const events = []
  let bad = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && typeof value.type === 'string') events.push(value)
      else bad++
    } catch (e) { bad++ }
  }
  if (events.length === 0 && bad > 0) {
    // 有内容却一条都解析不出来：这是损坏，不是"空存储"。
    throw fail(ASSOC_REASONS.STORE_CORRUPT, file + ' has content but no readable records (' + bad + ' bad line(s))')
  }
  return events
}

const foldRecords = (events) => {
  const records = new Map()
  for (const event of events) {
    if (event.type === 'bind') {
      if (typeof event.taskId !== 'string' || typeof event.originThreadId !== 'string') continue
      records.set(event.taskId, {
        originThreadId: event.originThreadId,
        taskId: event.taskId,
        kind: event.kind,
        target: event.target,
        profile: event.profile,
        status: typeof event.status === 'string' ? event.status : 'accepted',
        createdAt: event.at,
        updatedAt: event.at,
        delivered: event.delivered,
        result: undefined,
        error: undefined,
        reason: undefined,
        stopReason: undefined,
      })
      continue
    }
    if (event.type === 'update') {
      const record = records.get(event.taskId)
      if (record === undefined) continue
      for (const key of ['status', 'delivered', 'result', 'error', 'reason', 'stopReason', 'requestId', 'dshTurn']) {
        if (event[key] !== undefined) record[key] = event[key]
      }
      record.updatedAt = event.at
    }
  }
  return records
}

/**
 * 打开任务关联存储。方法与收件箱同风格：同步、语义确定。
 * @param {{root?: string, namespace?: string, lockTimeoutMs?: number, profile?: string}} options
 */
export const openAssociations = (options = {}) => {
  const root = resolveAssocRoot(options.root)
  const namespace = resolveNamespace(options.namespace)
  const dir = path.join(root, namespace)
  const file = path.join(dir, 'bindings.jsonl')
  const lock = createFileLock({ lockFile: path.join(dir, '.write.lock'), timeoutMs: options.lockTimeoutMs })
  const profile = typeof options.profile === 'string' && options.profile !== '' ? options.profile : (process.env.DSH_PROFILE || undefined)

  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true }) }

  const load = () => foldRecords(readJsonLines(file))

  /** 追加一行；先修记录边界（末字节不是换行就先补换行），避免残尾吞掉新记录。 */
  const appendEvent = (event) => {
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
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
  }

  return {
    root,
    namespace,
    dir,
    file,

    /**
     * 登记一条关联。**必须在执行前调用**：写盘失败就抛错，让调用方放弃启动 DSH 执行
     * （绝不出现"执行了却没绑定"）。
     */
    bind({ originThreadId, taskId, kind, target, delivered }) {
      if (!isValidOrigin(originThreadId)) {
        throw fail(ASSOC_REASONS.INVALID_ORIGIN, 'originThreadId must be a non-empty string of at most ' + MAX_ORIGIN_LENGTH + ' characters without control characters')
      }
      if (typeof taskId !== 'string' || taskId.trim() === '') throw fail(ASSOC_REASONS.UNKNOWN_TASK, 'taskId is required')
      return lock.withLock(() => {
        const existing = load().get(taskId)
        if (existing !== undefined && existing.originThreadId !== originThreadId.trim()) {
          throw fail(ASSOC_REASONS.ORIGIN_CONFLICT, 'task ' + taskId + ' is already bound to another origin', { taskId })
        }
        if (existing !== undefined) return existing
        const at = Date.now()
        appendEvent({
          type: 'bind',
          version: 1,
          originThreadId: originThreadId.trim(),
          taskId,
          kind,
          target,
          profile,
          status: 'accepted',
          delivered: delivered === true ? true : undefined,
          at,
        })
        return load().get(taskId)
      })
    },

    /** 更新终态/交付信息。任务未登记 → unknown-task（不静默新建）。 */
    update(taskId, patch = {}) {
      if (typeof taskId !== 'string' || taskId.trim() === '') throw fail(ASSOC_REASONS.UNKNOWN_TASK, 'taskId is required')
      return lock.withLock(() => {
        const record = load().get(taskId)
        if (record === undefined) throw fail(ASSOC_REASONS.UNKNOWN_TASK, 'task ' + taskId + ' has no association record', { taskId })
        appendEvent({
          type: 'update',
          version: 1,
          taskId,
          status: typeof patch.status === 'string' ? patch.status : undefined,
          delivered: patch.delivered === undefined ? undefined : patch.delivered === true,
          result: typeof patch.result === 'string' ? patch.result : undefined,
          error: typeof patch.error === 'string' ? patch.error : undefined,
          reason: typeof patch.reason === 'string' ? patch.reason : undefined,
          stopReason: typeof patch.stopReason === 'string' ? patch.stopReason : undefined,
          requestId: typeof patch.requestId === 'string' ? patch.requestId : undefined,
          dshTurn: typeof patch.dshTurn === 'number' ? patch.dshTurn : undefined,
          at: Date.now(),
        })
        return load().get(taskId)
      })
    },

    record(taskId) {
      return load().get(taskId)
    },

    /** 精确取值：必须 origin 匹配；不匹配/缺失一律拒绝，**失败时不返回任何 record**（不泄漏别人的结果）。 */
    fetch({ originThreadId, taskId }) {
      if (typeof taskId !== 'string' || taskId.trim() === '') return { ok: false, reason: ASSOC_REASONS.UNKNOWN_TASK }
      const record = load().get(taskId)
      if (record === undefined) return { ok: false, reason: ASSOC_REASONS.UNKNOWN_TASK }
      if (!isValidOrigin(originThreadId)) return { ok: false, reason: ASSOC_REASONS.MISSING_ORIGIN }
      if (record.originThreadId !== originThreadId.trim()) return { ok: false, reason: ASSOC_REASONS.ORIGIN_MISMATCH }
      return { ok: true, record }
    },

    /** 列出某个来源登记过的任务（找回丢失的 taskId 用），最新在前。 */
    byOrigin(originThreadId, filter = {}) {
      if (!isValidOrigin(originThreadId)) return { ok: false, reason: ASSOC_REASONS.INVALID_ORIGIN }
      const origin = originThreadId.trim()
      const all = Array.from(load().values()).filter((r) => r.originThreadId === origin)
      all.sort((a, b) => b.createdAt - a.createdAt)
      const limit = typeof filter.limit === 'number' && filter.limit > 0 ? filter.limit : undefined
      return { ok: true, originThreadId: origin, tasks: limit === undefined ? all : all.slice(0, limit) }
    },

    count() {
      return load().size
    },
  }
}
