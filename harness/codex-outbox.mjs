/**
 * codex-outbox.mjs —— DSH → Codex 的本地持久化收件箱（纯 Node，无依赖，可单测）。
 *
 * 为什么存在：M0 已证明本机 Windows 上**没有可附着的桌面端点**（见
 * docs/codex-desktop-attachment-evidence.md），因此"DSH 主动发消息并触发 Codex 回复"
 * 的自动唤醒部分处于 blocked。这里交付的是它可独立验证的那一半：一个不会丢、不会重复、
 * 重启可恢复的消息收件箱。Codex 侧（或用户）主动来读、确认收到、回复回填。
 *
 * 可靠性设计（对应本轮修复的 P1-1 / P1-2）：
 *   - **记录边界**：追加前先看末字节；不是换行（上次写入被截断）就先补一个换行，把残尾封成
 *     一条独立的坏行（读取时跳过），保证新事件从干净的行首开始——否则新事件会被拼进残行、
 *     一起被跳过，表现为"写入成功却查不到"。
 *   - **跨进程写事务**：绑定更新、幂等检查、seq 分配、事件追加全部在写锁内串行化。
 *     锁就是**一个共享路径** `<root>/.write.lock`，互斥只来自**一次原子独占创建**
 *     （硬链接发布 / `wx` 独占创建）：谁创建成功谁进临界区。**在线竞争期间绝不自动回收**
 *     ——"检查共享路径再删除"无法原子化，回收者可能删掉别人刚建的新锁。因此持有者活着就
 *     有限等待（超时报 lock-timeout），持有者已死报 lock-stale-holder、元数据不可确认报
 *     lock-unverified-holder，两者都是**可恢复错误 + 人工清理**，宁可阻塞也不冒双写者风险。
 *   - **原子替换**：绑定表写临时文件再 rename；读取时"文件存在但读不动/解析失败"直接抛错，
 *     绝不退化成空收件箱（否则权限/I-O 故障会伪装成"没有绑定"）。
 *   - 能力如实上报：canWakeIdle=false、deliveryMode='inbox'，绝不宣称自动唤醒可用。
 *
 * 存储位置默认在用户目录（`~/.dsh-codex-inbox`），**不写进仓库**；`--root`/环境变量可改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileLock } from './fs-lock.mjs'

export const OUTBOX_FORMAT_VERSION = 1

/** 消息状态。delivery-unknown 是留给将来接入适配器时"发起后连接断了、无法确认服务端是否接受"的。 */
export const MESSAGE_STATES = {
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  ACKED: 'acked',
  FAILED: 'failed',
  UNKNOWN: 'delivery-unknown',
}

/** 稳定的失败原因，便于调用方分支处理（不解析人类文案）。 */
export const INBOX_REASONS = {
  UNBOUND_TARGET: 'unbound-target',
  BINDING_THREAD_MISMATCH: 'binding-thread-mismatch',
  INVALID_INPUT: 'invalid-input',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  ILLEGAL_STATE: 'illegal-state-transition',
  UNKNOWN_MESSAGE: 'unknown-message',
  /** 写事务拿不到锁（且持有者活着）：明确失败，不假装写成功，也不抢别人的锁。 */
  LOCK_TIMEOUT: 'lock-timeout',
  /**
   * 锁的持有者**已死**。不自动回收：在共享路径上"检查再删除"存在 ABA/TOCTOU
   * （回收者可能删掉别人刚创建的新锁），无法证明安全。fail closed，给人工恢复步骤。
   */
  LOCK_STALE_HOLDER: 'lock-stale-holder',
  /**
   * 锁存在但**无法确认持有者**（内容空/损坏/不可读）。同样不以任何时间规则回收。
   */
  LOCK_UNVERIFIED_HOLDER: 'lock-unverified-holder',
  /** 存储存在但读不动（权限/IO）：必须报错，不能当成空收件箱。 */
  STORE_UNREADABLE: 'store-unreadable',
  /** 存储被写坏（JSON 解析失败/结构不对）：同上，不静默清空。 */
  STORE_CORRUPT: 'store-corrupt',
  /** 内部不变量：事件写完后读不到自己的消息。宁可报错也不返回 undefined。 */
  WRITE_FAILED: 'write-failed',
}

/**
 * 本机桌面接入能力如实描述。M0 结论：无可附着端点 → 只能收件箱模式。
 * 三个能力必须分清：canWakeIdle（自动唤醒空闲聊天）、canObserveTurns（能观察回合事件）、
 * deliveryMode='inbox'（用户/Codex 主动来取）。绝不把收件箱说成唤醒。
 */
export const INBOX_CAPABILITIES = {
  available: false,
  deliveryMode: 'inbox',
  canWakeIdle: false,
  canObserveTurns: false,
  reason: 'desktop-attachment-unavailable',
  detail: 'desktop app-server runs stdio:// owned by its desktop parent; no attachable endpoint on this host (M0, docs/codex-desktop-attachment-evidence.md)',
}

/**
 * 写锁就是**一个共享路径** `<root>/.write.lock`，实现复用 `fs-lock.mjs`（同一把锁的算法也被
 * 任务关联存储使用）。互斥只靠一次原子独占创建；**在线竞争期间绝不自动回收**：
 *   - 持有者活着 → 有限等待，超时报 lock-timeout；
 *   - 持有者已死 → 二次确认后报 lock-stale-holder（可恢复错误，人工清理）；
 *   - 元数据空/损坏 → 报 lock-unverified-holder（可恢复错误，人工清理）。
 * 上一版"编号 claim + 选举 + 自动回收"被证明编号会被迟到发布者复用，已整块删除。
 */
const LOCK_FILE_NAME = '.write.lock'
const DEFAULT_LOCK_TIMEOUT_MS = 10000

const now = () => Date.now()
const uid = (prefix) => prefix + '-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

/** 收件箱根目录：显式参数 > 环境变量 > 用户目录。绝不默认落到仓库里。 */
export const resolveRoot = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  const fromEnv = process.env.DSH_CODEX_INBOX_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh-codex-inbox')
}

const fail = (reason, message, extra) => Object.assign(new Error(message), { reason, ...(extra === undefined ? {} : extra) })

/** 读取事件日志。坏行跳过（半行/损坏行不该毁掉整个收件箱），但不影响写入侧的边界修复。 */
const readEvents = (file) => {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return []
    throw fail(INBOX_REASONS.STORE_UNREADABLE, 'cannot read ' + file + ': ' + e.message)
  }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && typeof value.type === 'string') out.push(value)
    } catch (e) { /* 残尾/坏行：跳过 */ }
  }
  return out
}

/** 折叠事件日志得到当前状态。 */
const foldMessages = (events) => {
  const messages = new Map()
  for (const event of events) {
    if (event.type === 'enqueue') {
      if (typeof event.messageId !== 'string') continue
      messages.set(event.messageId, {
        messageId: event.messageId,
        bindingId: event.bindingId,
        codexThreadId: event.codexThreadId,
        sourceSessionId: event.sourceSessionId,
        text: event.text,
        idempotencyKey: event.idempotencyKey,
        deliver: event.deliver,
        seq: event.seq,
        state: MESSAGE_STATES.QUEUED,
        createdAt: event.at,
        updatedAt: event.at,
        deliveredAt: undefined,
        ackedAt: undefined,
        turnId: undefined,
        reply: undefined,
        failureReason: undefined,
      })
      continue
    }
    const message = messages.get(event.messageId)
    if (message === undefined) continue
    if (event.type === 'delivered') {
      message.state = MESSAGE_STATES.DELIVERED
      message.deliveredAt = event.at
      message.deliveredBy = event.by
    } else if (event.type === 'acked') {
      message.state = MESSAGE_STATES.ACKED
      message.ackedAt = event.at
      if (event.reply !== undefined) message.reply = event.reply
      if (event.turnId !== undefined) message.turnId = event.turnId
    } else if (event.type === 'failed') {
      message.state = MESSAGE_STATES.FAILED
      message.failureReason = event.reason
    } else if (event.type === 'unknown') {
      message.state = MESSAGE_STATES.UNKNOWN
      message.failureReason = event.reason
    }
    message.updatedAt = event.at
  }
  return messages
}

/**
 * 打开收件箱。所有方法都是同步的：文件很小、语义要确定，同步反而更不容易出错。
 * 写入路径全部经过一把跨进程文件锁（P1-2），读路径不加锁。
 * @param {{root?: string, lockTimeoutMs?: number}} options
 */
export const openOutbox = (options = {}) => {
  const root = resolveRoot(options.root)
  const lockTimeoutMs = typeof options.lockTimeoutMs === 'number' && options.lockTimeoutMs > 0 ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS
  const bindingsFile = path.join(root, 'bindings.json')
  const eventsFile = path.join(root, 'messages.jsonl')
  const lockFile = path.join(root, LOCK_FILE_NAME)
  // 锁算法在 fs-lock.mjs（同一把锁也被任务关联存储使用）：独占创建 + 从不自动回收，
  // 失败原因是 lock-timeout / lock-stale-holder / lock-unverified-holder（与 INBOX_REASONS 同名同值）。
  const lock = createFileLock({ lockFile, timeoutMs: lockTimeoutMs })

  const ensureRoot = () => { fs.mkdirSync(root, { recursive: true }) }

  /** 在写锁内执行；异常路径也保证释放。 */
  const withLock = (fn) => lock.withLock(fn)

  /**
   * 追加一个事件。**记录边界**：末字节不是换行时先补换行，把残尾封成独立坏行，
   * 保证新事件从干净行首开始（否则会和残尾拼成一行、一起被跳过）。
   * 必须在写锁内调用。
   */
  const appendEventLocked = (event) => {
    ensureRoot()
    let size = 0
    try { size = fs.statSync(eventsFile).size } catch (e) { size = 0 }
    if (size > 0) {
      let last = 0
      const fd = fs.openSync(eventsFile, 'r')
      try {
        const buf = Buffer.alloc(1)
        fs.readSync(fd, buf, 0, 1, size - 1)
        last = buf[0]
      } finally {
        fs.closeSync(fd)
      }
      if (last !== 0x0a) fs.appendFileSync(eventsFile, '\n', 'utf8')
    }
    fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8')
  }

  /**
   * 读绑定表。**文件存在但读不动/解析失败 → 抛错**，绝不退化成空表：
   * 权限或 I/O 故障伪装成"没有绑定"会让调用方以为未绑定而放弃，或更糟，以为无人使用。
   */
  const loadBindings = () => {
    let text
    try {
      text = fs.readFileSync(bindingsFile, 'utf8')
    } catch (e) {
      if (e !== null && typeof e === 'object' && e.code === 'ENOENT') return {}
      throw fail(INBOX_REASONS.STORE_UNREADABLE, 'cannot read ' + bindingsFile + ': ' + e.message)
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch (e) {
      throw fail(INBOX_REASONS.STORE_CORRUPT, 'bindings file is not valid JSON: ' + e.message)
    }
    if (doc === null || typeof doc !== 'object' || doc.bindings === null || typeof doc.bindings !== 'object' || Array.isArray(doc.bindings)) {
      throw fail(INBOX_REASONS.STORE_CORRUPT, 'bindings file has unexpected shape')
    }
    return doc.bindings
  }

  /** 原子替换绑定表：先写临时文件再 rename，避免中途崩溃把文件截断。必须在写锁内调用。 */
  const saveBindingsLocked = (bindings) => {
    ensureRoot()
    const tmp = bindingsFile + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    fs.writeFileSync(tmp, JSON.stringify({ formatVersion: OUTBOX_FORMAT_VERSION, bindings }, null, 2) + '\n', 'utf8')
    try {
      fs.renameSync(tmp, bindingsFile)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (e2) { /* ignore */ }
      throw fail(INBOX_REASONS.STORE_UNREADABLE, 'cannot replace bindings file: ' + e.message)
    }
  }

  const loadMessages = () => foldMessages(readEvents(eventsFile))

  const requireMessage = (messages, messageId) => {
    const message = messages.get(messageId)
    if (message === undefined) throw fail(INBOX_REASONS.UNKNOWN_MESSAGE, 'unknown messageId ' + messageId)
    return message
  }

  const box = {
    root,
    bindingsFile,
    eventsFile,
    lockFile,
    capabilities: () => ({ ...INBOX_CAPABILITIES, root }),

    /**
     * 显式登记一个绑定。**只接受显式调用**：不按标题猜、不从最近使用里挑默认目标。
     * 同一个 bindingId 再次登记必须是同一个 threadId，否则报错（防止悄悄改投别处）。
     */
    bind({ bindingId, codexThreadId, sourceSessionId, note }) {
      if (typeof bindingId !== 'string' || bindingId.trim() === '') throw fail(INBOX_REASONS.INVALID_INPUT, 'bindingId is required')
      if (typeof codexThreadId !== 'string' || codexThreadId.trim() === '') throw fail(INBOX_REASONS.INVALID_INPUT, 'codexThreadId is required')
      return withLock(() => {
        const bindings = loadBindings()
        const existing = bindings[bindingId]
        if (existing !== undefined && existing.codexThreadId !== codexThreadId) {
          throw fail(INBOX_REASONS.BINDING_THREAD_MISMATCH, 'binding ' + bindingId + ' already points at thread ' + existing.codexThreadId)
        }
        const at = now()
        bindings[bindingId] = {
          bindingId,
          codexThreadId,
          sourceSessionId: typeof sourceSessionId === 'string' && sourceSessionId !== '' ? sourceSessionId : (existing === undefined ? undefined : existing.sourceSessionId),
          note: typeof note === 'string' && note !== '' ? note : (existing === undefined ? undefined : existing.note),
          createdAt: existing === undefined ? at : existing.createdAt,
          updatedAt: at,
          capabilities: { ...INBOX_CAPABILITIES },
        }
        saveBindingsLocked(bindings)
        return bindings[bindingId]
      })
    },

    listBindings() {
      const bindings = loadBindings()
      return Object.values(bindings).sort((a, b) => a.bindingId.localeCompare(b.bindingId))
    },

    /**
     * 写入一条待投递消息。写盘成功才返回 queued（计划 §6）。
     * 幂等：同 binding + 同 idempotencyKey 且正文一致 → 返回原消息（duplicate=true）；
     *       正文不一致 → idempotency-conflict（不覆盖、不新建）。
     * 幂等检查 + seq 分配 + 追加在同一把跨进程写锁内完成，否则两个进程会各自读到旧快照。
     */
    enqueue({ bindingId, text, idempotencyKey, sourceSessionId, deliver }) {
      if (typeof bindingId !== 'string' || bindingId.trim() === '') throw fail(INBOX_REASONS.INVALID_INPUT, 'bindingId is required')
      if (typeof text !== 'string' || text.trim() === '') throw fail(INBOX_REASONS.INVALID_INPUT, 'text is required')
      const mode = deliver === undefined ? 'queue' : deliver
      if (mode !== 'queue' && mode !== 'steer') throw fail(INBOX_REASONS.INVALID_INPUT, 'deliver must be queue or steer')
      const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : undefined

      return withLock(() => {
        const bindings = loadBindings()
        const binding = bindings[bindingId]
        if (binding === undefined) {
          // 未绑定一律拒绝：绝不静默新建目标（计划 §5）。
          throw fail(INBOX_REASONS.UNBOUND_TARGET, 'binding ' + bindingId + ' is not registered; bind an explicit threadId first')
        }
        const messages = loadMessages()
        if (key !== undefined) {
          for (const message of messages.values()) {
            if (message.bindingId !== bindingId || message.idempotencyKey !== key) continue
            if (message.text === text) return { message: { ...message }, duplicate: true }
            throw fail(INBOX_REASONS.IDEMPOTENCY_CONFLICT, 'idempotencyKey ' + key + ' already used with different text', { messageId: message.messageId })
          }
        }
        let seq = 0
        for (const message of messages.values()) {
          if (message.bindingId === bindingId && typeof message.seq === 'number' && message.seq > seq) seq = message.seq
        }
        const at = now()
        const messageId = uid('msg')
        appendEventLocked({
          type: 'enqueue',
          formatVersion: OUTBOX_FORMAT_VERSION,
          messageId,
          bindingId,
          codexThreadId: binding.codexThreadId,
          sourceSessionId: typeof sourceSessionId === 'string' && sourceSessionId !== '' ? sourceSessionId : binding.sourceSessionId,
          text,
          idempotencyKey: key,
          deliver: mode,
          seq: seq + 1,
          at,
        })
        // 写完必须能查到；查不到就是内部不变量被破坏，宁可报错也不返回 undefined。
        const written = foldMessages(readEvents(eventsFile)).get(messageId)
        if (written === undefined) {
          throw fail(INBOX_REASONS.WRITE_FAILED, 'event was appended but could not be read back; the record boundary is broken', { messageId })
        }
        return { message: written, duplicate: false }
      })
    },

    listMessages(filter = {}) {
      const messages = Array.from(loadMessages().values())
      const bindingId = filter.bindingId
      const state = filter.state
      const filtered = messages.filter((m) => (bindingId === undefined || m.bindingId === bindingId) && (state === undefined || m.state === state))
      filtered.sort((a, b) => (a.seq - b.seq) || (a.createdAt - b.createdAt))
      const limit = typeof filter.limit === 'number' && filter.limit > 0 ? filter.limit : undefined
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },

    /** 待投递（还没被 Codex 侧取走的）消息，按绑定内顺序。 */
    pending(bindingId) {
      return this.listMessages({ bindingId, state: MESSAGE_STATES.QUEUED })
    },

    getMessage(messageId) {
      return requireMessage(loadMessages(), messageId)
    },

    markDelivered(messageId, meta = {}) {
      return withLock(() => {
        const message = requireMessage(loadMessages(), messageId)
        if (message.state !== MESSAGE_STATES.QUEUED) {
          throw fail(INBOX_REASONS.ILLEGAL_STATE, 'cannot mark delivered from state ' + message.state)
        }
        appendEventLocked({ type: 'delivered', messageId, by: meta.by, at: now() })
        return requireMessage(loadMessages(), messageId)
      })
    },

    /** Codex 侧确认已处理；可回填回复正文与 turnId，把结果关联回这条 messageId。 */
    ack(messageId, meta = {}) {
      return withLock(() => {
        const message = requireMessage(loadMessages(), messageId)
        if (message.state === MESSAGE_STATES.ACKED) return message
        if (message.state === MESSAGE_STATES.FAILED) {
          throw fail(INBOX_REASONS.ILLEGAL_STATE, 'cannot ack a failed message')
        }
        appendEventLocked({ type: 'acked', messageId, reply: meta.reply, turnId: meta.turnId, by: meta.by, at: now() })
        return requireMessage(loadMessages(), messageId)
      })
    },

    markFailed(messageId, reason) {
      return withLock(() => {
        const message = requireMessage(loadMessages(), messageId)
        if (message.state === MESSAGE_STATES.ACKED) {
          throw fail(INBOX_REASONS.ILLEGAL_STATE, 'cannot fail an acked message')
        }
        appendEventLocked({ type: 'failed', messageId, reason: reason === undefined ? 'unspecified' : reason, at: now() })
        return requireMessage(loadMessages(), messageId)
      })
    },

    /**
     * 留给将来适配器：请求已发出但连接断了、无法确认服务端是否接受。
     * 明确标成未知而不是失败，避免调用方把它当成"没发出去"而盲目重发（计划 §6）。
     */
    markUnknown(messageId, reason) {
      return withLock(() => {
        const message = requireMessage(loadMessages(), messageId)
        if (message.state === MESSAGE_STATES.ACKED) {
          throw fail(INBOX_REASONS.ILLEGAL_STATE, 'cannot mark unknown after ack')
        }
        appendEventLocked({ type: 'unknown', messageId, reason: reason === undefined ? 'delivery-unconfirmed' : reason, at: now() })
        return requireMessage(loadMessages(), messageId)
      })
    },
  }

  return box
}
