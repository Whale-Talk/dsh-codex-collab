#!/usr/bin/env node
/**
 * codex-inbox.mjs —— DSH → Codex 收件箱的命令行入口（零依赖）。
 *
 * 用途：M0 已证明本机没有可附着的桌面端点（见 docs/codex-desktop-attachment-evidence.md），
 * 所以"自动唤醒桌面聊天"处于 blocked。这条 CLI 交付的是可独立验证的另一半：
 *   - DSH 侧：`send` 把要告诉 Codex 的话写进本地持久化收件箱（写盘成功才算 queued）。
 *   - Codex 侧/用户：`pending` 看到有哪些待办，`show` 看正文，`ack` 确认处理并回填回复。
 *
 * 能力如实上报：`capabilities` 永远显示 canWakeIdle=false / deliveryMode=inbox。
 * 不写仓库、不读凭据、不启动任何服务、不触碰 Codex 会话存储。
 *
 * 参数解析是**严格**的（P2-3）：除 `--help`/`--json` 两个布尔旗标外，任何带值旗标
 * 出现却没有值（或出现未知旗标）都直接 exit 2，且校验发生在**打开存储、做任何变更之前**。
 * 这样 `ack --reply`（缺值）不会被悄悄当成 undefined 而照常确认，`send --key`（缺值）
 * 不会静默丢掉幂等键，`--root`（缺值）也不会悄悄回落到真实默认目录。
 *
 * 存储默认在 ~/.dsh-codex-inbox，可用 --root 或 DSH_CODEX_INBOX_DIR 覆盖。
 */
import { INBOX_REASONS, MESSAGE_STATES, openOutbox } from '../harness/codex-outbox.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, UNBOUND: 3, CONFLICT: 4, UNKNOWN_MESSAGE: 5, ILLEGAL_STATE: 6 }

const REASON_EXIT = {
  [INBOX_REASONS.UNBOUND_TARGET]: EXIT.UNBOUND,
  [INBOX_REASONS.IDEMPOTENCY_CONFLICT]: EXIT.CONFLICT,
  [INBOX_REASONS.UNKNOWN_MESSAGE]: EXIT.UNKNOWN_MESSAGE,
  [INBOX_REASONS.ILLEGAL_STATE]: EXIT.ILLEGAL_STATE,
  [INBOX_REASONS.INVALID_INPUT]: EXIT.USAGE,
  [INBOX_REASONS.BINDING_THREAD_MISMATCH]: EXIT.CONFLICT,
  [INBOX_REASONS.STORE_CORRUPT]: EXIT.ERROR,
  [INBOX_REASONS.STORE_UNREADABLE]: EXIT.ERROR,
  [INBOX_REASONS.LOCK_TIMEOUT]: EXIT.ERROR,
  [INBOX_REASONS.LOCK_STALE_HOLDER]: EXIT.ERROR,
  [INBOX_REASONS.LOCK_UNVERIFIED_HOLDER]: EXIT.ERROR,
  [INBOX_REASONS.WRITE_FAILED]: EXIT.ERROR,
}

/** 带值的旗标：出现就必须紧跟一个值。 */
const VALUE_FLAGS = new Set(['root', 'binding', 'thread', 'source', 'note', 'text', 'key', 'deliver', 'reply', 'turn', 'by', 'reason', 'state', 'limit'])
/** 布尔旗标：唯一允许不带值的两种。 */
const BOOLEAN_FLAGS = new Set(['json', 'help'])

const USAGE = `codex-inbox —— DSH → Codex 本地收件箱（当前能力：只有收件箱，无桌面自动唤醒）

DSH 侧（发件）:
  codex-inbox send --binding <bindingId> --text "<正文>" [--key <幂等键>] [--source <DSH会话id>] [--deliver queue|steer]
  codex-inbox status <messageId>
  codex-inbox list [--binding <id>] [--state queued|delivered|acked|failed|delivery-unknown] [--limit N]

Codex 侧 / 用户（收件）:
  codex-inbox pending [--binding <id>]          # 待处理（按绑定内顺序）
  codex-inbox show <messageId>                  # 看正文
  codex-inbox delivered <messageId> [--by X]    # 标记已取走
  codex-inbox ack <messageId> [--reply "<回复>"] [--turn <turnId>]   # 确认处理 + 回填结果

绑定与能力:
  codex-inbox bind --binding <id> --thread <codexThreadId> [--source <DSH会话id>] [--note "<说明>"]
  codex-inbox bindings
  codex-inbox capabilities                       # 只读能力报告（含 reason）

公共: --root <dir>（默认 ~/.dsh-codex-inbox，或 DSH_CODEX_INBOX_DIR）
      --json（机器可读输出；默认对对象类命令已经输出 JSON）
      带值旗标缺值、或出现未知旗标 → 退出码 2（在打开存储之前就拒绝）

退出码: 0 成功 / 1 失败 / 2 用法 / 3 未绑定 / 4 幂等冲突 / 5 未知消息 / 6 非法状态转移`

/**
 * 严格解析。返回 { positional, flags, errors }；errors 非空时调用方必须在**打开存储之前**退出。
 * 规则：`--help`/`--json` 可裸用；其余 `--x` 必须有值，否则记错；不认识的旗标记错。
 */
export const parseArgs = (argv) => {
  const positional = []
  const flags = {}
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (typeof arg !== 'string' || !arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (name === '') { errors.push('空旗标 "--"'); continue }
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue }
    if (!VALUE_FLAGS.has(name)) { errors.push('未知旗标 --' + name); continue }
    const next = argv[i + 1]
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      errors.push('--' + name + ' 需要一个值')
      continue
    }
    flags[name] = next
    i++
  }
  return { positional, flags, errors }
}

const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
const note = (text) => process.stderr.write(text + '\n')

const main = () => {
  const { positional, flags, errors } = parseArgs(process.argv.slice(2))
  const command = positional[0]

  if (flags.help === true) {
    note(USAGE)
    return EXIT.OK
  }
  if (command === 'help') {
    note(USAGE)
    return EXIT.OK
  }
  if (command === undefined) {
    note(USAGE)
    return EXIT.USAGE
  }
  // 参数错误一律在这里结束：**尚未打开存储、尚未做任何变更**。
  if (errors.length > 0) {
    for (const error of errors) note('参数错误: ' + error)
    note(USAGE)
    return EXIT.USAGE
  }
  // 值域校验同样放在打开存储之前。
  if (flags.deliver !== undefined && flags.deliver !== 'queue' && flags.deliver !== 'steer') {
    note('参数错误: --deliver 只接受 queue 或 steer')
    return EXIT.USAGE
  }
  if (flags.limit !== undefined && !Number.isFinite(Number(flags.limit))) {
    note('参数错误: --limit 需要数字')
    return EXIT.USAGE
  }

  try {
    const box = openOutbox({ root: typeof flags.root === 'string' ? flags.root : undefined })

    const requireFlag = (name) => {
      const value = flags[name]
      if (typeof value !== 'string' || value.trim() === '') {
        note('缺少 --' + name + '\n\n' + USAGE)
        process.exitCode = EXIT.USAGE
        throw Object.assign(new Error('missing --' + name), { reason: 'usage' })
      }
      return value
    }

    if (command === 'capabilities') {
      out(box.capabilities())
      return EXIT.OK
    }

    if (command === 'bind') {
      const binding = box.bind({
        bindingId: requireFlag('binding'),
        codexThreadId: requireFlag('thread'),
        sourceSessionId: typeof flags.source === 'string' ? flags.source : undefined,
        note: typeof flags.note === 'string' ? flags.note : undefined,
      })
      out({ ok: true, root: box.root, binding })
      return EXIT.OK
    }

    if (command === 'bindings') {
      out({ ok: true, root: box.root, bindings: box.listBindings(), capabilities: box.capabilities() })
      return EXIT.OK
    }

    if (command === 'send') {
      const result = box.enqueue({
        bindingId: requireFlag('binding'),
        text: requireFlag('text'),
        idempotencyKey: typeof flags.key === 'string' ? flags.key : undefined,
        sourceSessionId: typeof flags.source === 'string' ? flags.source : undefined,
        deliver: typeof flags.deliver === 'string' ? flags.deliver : 'queue',
      })
      out({
        ok: true,
        duplicate: result.duplicate,
        messageId: result.message.messageId,
        state: result.message.state,
        seq: result.message.seq,
        bindingId: result.message.bindingId,
        codexThreadId: result.message.codexThreadId,
        capabilities: box.capabilities(),
        note: result.duplicate
          ? '同一幂等键与相同正文：未重复入队，返回原 messageId'
          : '已写入本地收件箱（queued）。本机没有可附着的桌面端点，Codex 需主动来读（codex-inbox pending）。',
      })
      return EXIT.OK
    }

    if (command === 'pending') {
      const messages = box.pending(typeof flags.binding === 'string' ? flags.binding : undefined)
      out({ ok: true, root: box.root, count: messages.length, messages, capabilities: box.capabilities() })
      if (messages.length === 0) note('收件箱没有待处理消息。')
      else note('有待处理消息 ' + messages.length + ' 条；处理完用 codex-inbox ack <messageId> 回填。')
      return EXIT.OK
    }

    if (command === 'list') {
      const messages = box.listMessages({
        bindingId: typeof flags.binding === 'string' ? flags.binding : undefined,
        state: typeof flags.state === 'string' ? flags.state : undefined,
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
      })
      out({ ok: true, root: box.root, count: messages.length, messages })
      return EXIT.OK
    }

    const messageId = positional[1]
    if (messageId === undefined || messageId === '') {
      note('缺少 <messageId>\n\n' + USAGE)
      return EXIT.USAGE
    }

    if (command === 'show' || command === 'status') {
      out({ ok: true, message: box.getMessage(messageId) })
      return EXIT.OK
    }
    if (command === 'delivered') {
      out({ ok: true, message: box.markDelivered(messageId, { by: typeof flags.by === 'string' ? flags.by : 'codex-side' }) })
      return EXIT.OK
    }
    if (command === 'ack') {
      out({
        ok: true,
        message: box.ack(messageId, {
          reply: typeof flags.reply === 'string' ? flags.reply : undefined,
          turnId: typeof flags.turn === 'string' ? flags.turn : undefined,
          by: typeof flags.by === 'string' ? flags.by : 'codex-side',
        }),
      })
      return EXIT.OK
    }
    if (command === 'fail') {
      out({ ok: true, message: box.markFailed(messageId, requireFlag('reason')) })
      return EXIT.OK
    }
    if (command === 'unknown') {
      out({ ok: true, message: box.markUnknown(messageId, typeof flags.reason === 'string' ? flags.reason : undefined) })
      return EXIT.OK
    }

    note('未知子命令: ' + command + '\n\n' + USAGE)
    return EXIT.USAGE
  } catch (e) {
    if (e !== null && typeof e === 'object' && e.reason === 'usage') return EXIT.USAGE
    const reason = e !== null && typeof e === 'object' && typeof e.reason === 'string' ? e.reason : undefined
    out({ ok: false, reason: reason === undefined ? 'error' : reason, error: e.message, ...(e.messageId === undefined ? {} : { messageId: e.messageId }) })
    if (reason === INBOX_REASONS.UNBOUND_TARGET) {
      note('该 binding 未登记。先用 codex-inbox bind --binding <id> --thread <codexThreadId> 显式绑定（不猜目标）。')
    }
    if (reason === INBOX_REASONS.LOCK_TIMEOUT) {
      note('另一个进程正在写这个收件箱且仍然活着：本次没有写入，也没有抢它的锁。稍后重试。')
    }
    if (reason === INBOX_REASONS.LOCK_STALE_HOLDER) {
      note('写锁的持有者进程已经不存在，但工具**不会**在线自动回收它（在共享路径上"检查再删除"会误删别人刚建的锁）。'
        + '请确认没有任何写入进程在运行，然后手动删除错误里给出的锁文件，再重试。')
    }
    if (reason === INBOX_REASONS.LOCK_UNVERIFIED_HOLDER) {
      note('写锁的元数据无法确认持有者（空/损坏）。工具不会按时间回收它。'
        + '请先确认没有写入进程在运行，再人工检查错误里给出的那个文件（确认无人使用后可自行删除）。')
    }
    return REASON_EXIT[reason] === undefined ? EXIT.ERROR : REASON_EXIT[reason]
  }
}

/** 只有作为程序直接运行时才执行；被 import（例如解析单测）时不得调用 process.exit。 */
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isDirectRun) process.exit(main())
