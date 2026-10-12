/**
 * fs-lock.mjs —— 本机跨进程写锁（零依赖），供收件箱与任务关联存储复用。
 *
 * 互斥只靠一条：**一个共享路径**上的一次**原子独占创建**（先把完整元数据写进唯一命名的
 * `pending-<token>.json`，再 `linkSync` 到锁路径；平台不支持硬链接时退化为 `wx` 独占创建 + 立即写入）。
 * 共享路径只能被创建成功一次，所以同一时刻至多一个持有者。
 *
 * **在线竞争期间绝不自动回收**：在共享路径上"检查持有者 → 再删除/改名"无法原子化，回收者可能
 * 删掉别人刚创建的新锁（ABA/TOCTOU，已被真实复现过）。因此只有三种结果：
 *   - 持有者活着   → 有限等待，超时抛 lock-timeout；
 *   - 持有者已死   → 二次确认（锁仍在、仍是同一把、pid 仍不可达）后抛 lock-stale-holder（可恢复，人工清理）；
 *   - 元数据不可确认 → 抛 lock-unverified-holder（可恢复，人工清理）。
 * 宁可阻塞等待人工处理，也不冒"两个写者"的风险。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOCK_REASONS = {
  /** 持有者活着，等不到锁（可重试）。 */
  TIMEOUT: 'lock-timeout',
  /** 持有者已死：不自动回收，需人工清理（可恢复错误）。 */
  STALE_HOLDER: 'lock-stale-holder',
  /** 锁存在但无法确认持有者：不按时间偷（可恢复错误）。 */
  UNVERIFIED_HOLDER: 'lock-unverified-holder',
}

/** 观察到"无法确认持有者"的元数据后，最多再观察这么久（容忍原子创建的极小空窗），然后 fail closed。 */
const UNREADABLE_GRACE_MS = 200
/** 残留 pending 文件的清理年龄下限：先证明其记录里的 pid 已死，再删（名字唯一，不涉及共享路径）。 */
const PENDING_STALE_MS = 1000
const DEFAULT_TIMEOUT_MS = 10000

const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

/** 同步睡眠（不占 CPU）；Node 主线程允许 Atomics.wait。 */
const sleep = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (e) {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

export const isProcessAlive = (pid) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.code === 'ESRCH') return false
    // EPERM 等：进程存在但不是我们能发信号的 → 视为活着（宁可等，也不抢）
    return true
  }
}

const lockError = (reason, message, extra) => Object.assign(new Error(message), { reason, ...(extra === undefined ? {} : extra) })

/**
 * 在 `lockFile` 上创建一把跨进程写锁。
 * @param {{lockFile: string, timeoutMs?: number}} options
 */
export const createFileLock = (options) => {
  const lockFile = path.resolve(options.lockFile)
  const lockDir = path.dirname(lockFile)
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  const ensureDir = () => { fs.mkdirSync(lockDir, { recursive: true }) }

  /** 读锁的持有者元数据。读不动/解析失败/没有 pid → 无法确认持有者（调用方必须 fail closed）。 */
  const readLockMeta = () => {
    let text
    try {
      text = fs.readFileSync(lockFile, 'utf8')
    } catch (e) {
      if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return { ok: false, missing: true, why: 'lock file is gone' }
      return { ok: false, missing: false, why: 'unreadable (' + e.message + ')' }
    }
    let value
    try {
      value = JSON.parse(text)
    } catch (e) {
      return { ok: false, missing: false, why: 'content is not valid JSON' }
    }
    if (value === null || typeof value !== 'object' || typeof value.pid !== 'number' || !Number.isInteger(value.pid)) {
      return { ok: false, missing: false, why: 'content has no owner pid' }
    }
    return { ok: true, meta: value }
  }

  /**
   * 原子独占创建：先写完整元数据到唯一命名的 pending 文件，再硬链接到锁路径。
   * link 原子且独占，且"内容完整才可能可见"；不支持硬链接时退化为 `wx` + 立即写入
   * （极小空窗内竞争者会读到不可确认的元数据 → fail closed，只会短暂报错，绝不误删）。
   */
  const publishLock = (meta) => {
    ensureDir()
    const intentPath = path.join(lockDir, 'pending-' + meta.token + '.json')
    fs.writeFileSync(intentPath, JSON.stringify(meta), 'utf8')
    try {
      fs.linkSync(intentPath, lockFile)
      return true
    } catch (e) {
      if (e !== null && typeof e === 'object' && e.code === 'EEXIST') return false
      try {
        fs.writeFileSync(lockFile, JSON.stringify(meta), { encoding: 'utf8', flag: 'wx' })
        return true
      } catch (e2) {
        if (e2 !== null && typeof e2 === 'object' && e2.code === 'EEXIST') return false
        throw e2
      }
    } finally {
      try { fs.unlinkSync(intentPath) } catch (e) { /* 已被清理 */ }
    }
  }

  /** 清理残留 pending：只在能证明其记录里的 pid 已死、且已过短宽限时删（名字唯一，不碰共享路径）。 */
  const sweepPending = () => {
    let names
    try { names = fs.readdirSync(lockDir) } catch (e) { return }
    for (const name of names) {
      if (!name.startsWith('pending-')) continue
      const file = path.join(lockDir, name)
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs
        if (age < PENDING_STALE_MS) continue
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (owner !== null && typeof owner === 'object' && isProcessAlive(owner.pid)) continue
        fs.unlinkSync(file)
      } catch (e) { /* 读不到/已被清理：下一轮再说 */ }
    }
  }

  const acquire = () => {
    ensureDir()
    const token = uid('lock')
    const meta = { token, pid: process.pid, host: os.hostname(), at: Date.now() }
    const deadline = Date.now() + timeoutMs
    let unreadableSince

    for (;;) {
      sweepPending()

      // 1) 唯一的进入方式：原子独占创建。
      if (publishLock(meta)) return { token }

      // 2) 已存在：读元数据判定，只决定"等待 / 报错"，绝不删除或改名。
      const info = readLockMeta()
      if (info.missing === true) continue                    // 刚好被持有者释放：重试
      if (info.ok === true) {
        if (isProcessAlive(info.meta.pid)) {
          if (Date.now() > deadline) {
            const holder = 'pid ' + info.meta.pid
            throw lockError(LOCK_REASONS.TIMEOUT, 'could not acquire the write lock within ' + timeoutMs + 'ms; it is held by ' + holder + ' (a live holder is never stolen). Retry later.', { holder, file: lockFile })
          }
          sleep(15)
          continue
        }
        // 持有者看起来已死——但它可能刚刚**正常释放并退出**（读到内容之后、检查存活之前）。
        // 报 stale 之前必须二次确认：锁文件仍在、还是同一把（token 相同）、pid 仍不可达。
        const confirm = readLockMeta()
        if (confirm.missing === true) continue
        if (confirm.ok === true && confirm.meta.token === info.meta.token && !isProcessAlive(confirm.meta.pid)) {
          throw lockError(
            LOCK_REASONS.STALE_HOLDER,
            'the write lock is held by pid ' + info.meta.pid + ', which is no longer running. Refusing to auto-reclaim it online: removing a shared lock path is racy (a reclaimer can delete a lock someone else just created). '
            + 'Stop all writers, then delete ' + lockFile + ' manually and retry.',
            { file: lockFile, stalePid: info.meta.pid },
          )
        }
        continue
      }

      // 3) 元数据空/损坏：给原子创建留一点观察窗（只延迟报错，绝不删除），随后 fail closed。
      if (unreadableSince === undefined) unreadableSince = Date.now()
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        throw lockError(
          LOCK_REASONS.UNVERIFIED_HOLDER,
          'the write lock at ' + lockFile + ' has no verifiable owner (' + info.why + '); refusing to reclaim it on a timer. '
          + 'Stop the writers and inspect that file; remove it yourself only if you are sure no writer is running.',
          { file: lockFile },
        )
      }
      sleep(15)
    }
  }

  const release = (handle) => {
    // 只删自己创建的那把锁：核对 token 后删除。注意——这只是"尽力而为"的一致性检查，
    // **不是互斥的基础**；互斥来自独占创建 + 从不自动回收（没有任何自动路径会删活锁）。
    const info = readLockMeta()
    if (info.ok === true && info.meta.token === handle.token) {
      try { fs.unlinkSync(lockFile) } catch (e) { /* 已被外部清理 */ }
    }
  }

  const withLock = (fn) => {
    const handle = acquire()
    try {
      return fn()
    } finally {
      release(handle)
    }
  }

  return { lockFile, timeoutMs, acquire, release, withLock, readLockMeta }
}
