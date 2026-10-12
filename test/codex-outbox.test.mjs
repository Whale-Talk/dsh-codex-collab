/**
 * codex-outbox.mjs 的真实行为测试（不是恒真 mock）。
 *
 * M0 结论是"本机没有可附着的桌面端点"，所以这里验证的是被交付的那一半：
 * 收件箱不丢、不重、按序、重启可恢复、状态机与幂等语义正确、能力如实上报。
 * 跑法: node test/codex-outbox.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { INBOX_REASONS, MESSAGE_STATES, openOutbox } from '../harness/codex-outbox.mjs'

const OUTBOX_URL = pathToFileURL(path.resolve(import.meta.dirname, '..', 'harness', 'codex-outbox.mjs')).href

/** 子进程脚本：真进程、真文件锁（不是同一实例顺序调用的假并发）。 */
const CHILD_SRC = `
const url = process.argv[1]
const payload = JSON.parse(process.argv[2])
;(async () => {
  const fs = await import('node:fs')
  const { openOutbox } = await import(url)
  try {
    if (payload.goFile !== undefined) {
      const end = Date.now() + 15000
      while (!fs.existsSync(payload.goFile)) {
        if (Date.now() > end) throw new Error('go barrier timed out')
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const box = openOutbox({ root: payload.root, lockTimeoutMs: payload.lockTimeoutMs })
    let result
    if (payload.op === 'enqueue') result = box.enqueue(payload.args)
    else if (payload.op === 'bind') result = { binding: box.bind(payload.args) }
    else throw new Error('unknown op ' + payload.op)
    process.stdout.write(JSON.stringify({ ok: true, result }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, reason: e.reason, error: e.message }))
  }
})()
`

const runChild = (payload) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', CHILD_SRC, OUTBOX_URL, JSON.stringify(payload)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code !== 0 || stdout.trim() === '') return reject(new Error('child exit=' + code + ' stderr=' + stderr.slice(0, 400)))
    try { resolve(JSON.parse(stdout)) } catch (e) { reject(new Error('bad child output: ' + stdout.slice(0, 200))) }
  })
})

/** 等所有子进程就绪（go 屏障在事务之外，不干扰锁），再放行，制造真实竞争。 */
const runTogether = async (payloads) => {
  const goFile = path.join(payloads[0].root, 'go')
  fs.mkdirSync(payloads[0].root, { recursive: true })
  const pending = payloads.map((p) => runChild({ ...p, goFile }))
  await new Promise((r) => setTimeout(r, 200))
  fs.writeFileSync(goFile, '')
  return Promise.all(pending)
}

const tmpRoots = []
const tmpRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outbox-test-'))
  tmpRoots.push(dir)
  return dir
}

// 收尾清理：**先校验解析后的绝对目标**确实在系统临时根下且名字符合预期，再递归删除。
after(() => {
  for (const dir of tmpRoots) {
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) continue
    if (!path.basename(resolved).startsWith('codex-outbox-test-')) continue
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

/** 单把独占写锁的小工具。 */
const lockPathOf = (root) => path.join(root, '.write.lock')
const lockExists = (root) => fs.existsSync(lockPathOf(root))
const pendingFiles = (root) => { try { return fs.readdirSync(root).filter((n) => n.startsWith('pending-')) } catch (e) { return [] } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (predicate, label, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await sleep(10)
  }
}

/** 拿一个确定已经退出的 Node 进程 pid。 */
const deadProcessPid = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  child.on('error', reject)
  child.on('exit', () => resolve(child.pid))
})

const writeLock = (root, owner) => {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(lockPathOf(root), JSON.stringify({ host: 'test', at: Date.now(), ...owner }), 'utf8')
}

const throwsReason = (fn, reason) => {
  try {
    fn()
  } catch (e) {
    assert.equal(e.reason, reason, 'expected reason ' + reason + ' but got ' + e.reason)
    return e
  }
  throw new Error('expected a throw with reason ' + reason + ', but nothing was thrown')
}

test('capabilities: 只有收件箱，绝不宣称能唤醒桌面', () => {
  const box = openOutbox({ root: tmpRoot() })
  const caps = box.capabilities()
  assert.equal(caps.available, false)
  assert.equal(caps.deliveryMode, 'inbox')
  assert.equal(caps.canWakeIdle, false)
  assert.equal(caps.canObserveTurns, false)
  assert.equal(caps.reason, 'desktop-attachment-unavailable')
})

test('bind: 只接受显式登记，同一 binding 不许悄悄改投别的 thread', () => {
  const box = openOutbox({ root: tmpRoot() })
  const binding = box.bind({ bindingId: 'okx', codexThreadId: 'thread-fixture-1', sourceSessionId: 'session-fixture-1', note: 'local acceptance only' })
  assert.equal(binding.codexThreadId, 'thread-fixture-1')
  assert.equal(binding.sourceSessionId, 'session-fixture-1')

  // 同 thread 再登记：幂等
  const again = box.bind({ bindingId: 'okx', codexThreadId: 'thread-fixture-1' })
  assert.equal(again.createdAt, binding.createdAt)

  // 换 thread：明确拒绝
  const e = throwsReason(() => box.bind({ bindingId: 'okx', codexThreadId: 'other-thread' }), INBOX_REASONS.BINDING_THREAD_MISMATCH)
  assert.match(e.message, /already points at thread/)

  assert.equal(box.listBindings().length, 1)
})

test('enqueue: 未绑定的目标一律拒绝，且不会产生任何消息', () => {
  const box = openOutbox({ root: tmpRoot() })
  throwsReason(() => box.enqueue({ bindingId: 'nope', text: 'hello' }), INBOX_REASONS.UNBOUND_TARGET)
  assert.equal(box.listMessages().length, 0)
})

test('enqueue: 每个绑定内按 seq 严格有序，绑定之间互不干扰', () => {
  const root = tmpRoot()
  const box = openOutbox({ root })
  box.bind({ bindingId: 'a', codexThreadId: 'thread-a' })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const m1 = box.enqueue({ bindingId: 'a', text: '第一条' }).message
  const m2 = box.enqueue({ bindingId: 'b', text: '另一绑定的第一条' }).message
  const m3 = box.enqueue({ bindingId: 'a', text: '第二条' }).message

  assert.deepEqual([m1.seq, m3.seq], [1, 2])
  assert.equal(m2.seq, 1)
  assert.deepEqual(box.pending('a').map((m) => m.text), ['第一条', '第二条'])
  assert.deepEqual(box.pending('b').map((m) => m.text), ['另一绑定的第一条'])
  assert.equal(box.pending('a')[0].state, MESSAGE_STATES.QUEUED)
  assert.equal(box.pending('a')[0].codexThreadId, 'thread-a')
})

test('idempotency: 同键同文只入队一条；同键异文明确冲突', () => {
  const box = openOutbox({ root: tmpRoot() })
  box.bind({ bindingId: 'a', codexThreadId: 'thread-a' })

  const first = box.enqueue({ bindingId: 'a', text: '重试也要只发一次', idempotencyKey: 'k-1' })
  assert.equal(first.duplicate, false)
  const retry = box.enqueue({ bindingId: 'a', text: '重试也要只发一次', idempotencyKey: 'k-1' })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.message.messageId, first.message.messageId)
  assert.equal(box.listMessages().length, 1)

  const conflict = throwsReason(() => box.enqueue({ bindingId: 'a', text: '换了正文', idempotencyKey: 'k-1' }), INBOX_REASONS.IDEMPOTENCY_CONFLICT)
  assert.equal(conflict.messageId, first.message.messageId)
  assert.equal(box.listMessages().length, 1)
})

test('重启可恢复：重开同一 root 后消息与状态都在', () => {
  const root = tmpRoot()
  const first = openOutbox({ root })
  first.bind({ bindingId: 'a', codexThreadId: 'thread-a' })
  const queued = first.enqueue({ bindingId: 'a', text: '重启前写入的消息' }).message
  first.markDelivered(queued.messageId, { by: 'test' })

  const reopened = openOutbox({ root })
  const restored = reopened.getMessage(queued.messageId)
  assert.equal(restored.state, MESSAGE_STATES.DELIVERED)
  assert.equal(restored.text, '重启前写入的消息')
  assert.equal(reopened.pending('a').length, 0)          // 已取走，不再算待处理
  assert.equal(reopened.listMessages().length, 1)        // 但一条都没丢
  assert.equal(reopened.listBindings().length, 1)
})

test('状态机: 正常流转 ack 回填回复；非法转移直接拒绝', () => {
  const box = openOutbox({ root: tmpRoot() })
  box.bind({ bindingId: 'a', codexThreadId: 'thread-a' })
  const m = box.enqueue({ bindingId: 'a', text: 'DSH_TO_CODEX_canary' }).message

  // queued 不能直接 ack 后再 delivered
  box.markDelivered(m.messageId, { by: 'codex-side' })
  throwsReason(() => box.markDelivered(m.messageId, { by: 'again' }), INBOX_REASONS.ILLEGAL_STATE)

  const acked = box.ack(m.messageId, { reply: 'DSH_TO_CODEX_canary', turnId: 'turn-1' })
  assert.equal(acked.state, MESSAGE_STATES.ACKED)
  assert.equal(acked.reply, 'DSH_TO_CODEX_canary')
  assert.equal(acked.turnId, 'turn-1')

  // ack 幂等
  const again = box.ack(m.messageId)
  assert.equal(again.reply, 'DSH_TO_CODEX_canary')

  // 已 ack 不能再标失败
  throwsReason(() => box.markFailed(m.messageId, 'late failure'), INBOX_REASONS.ILLEGAL_STATE)
  throwsReason(() => box.getMessage('msg-does-not-exist'), INBOX_REASONS.UNKNOWN_MESSAGE)
})

test('投递未知: 明确标成 delivery-unknown，而不是"没发出去"', () => {
  const box = openOutbox({ root: tmpRoot() })
  box.bind({ bindingId: 'a', codexThreadId: 'thread-a' })
  const m = box.enqueue({ bindingId: 'a', text: '连接断开在发起之后' }).message
  const unknown = box.markUnknown(m.messageId, 'connection dropped after request; server acceptance unconfirmed')
  assert.equal(unknown.state, MESSAGE_STATES.UNKNOWN)
  assert.match(unknown.failureReason, /unconfirmed/)
  // 未知之后仍然允许补记 ack（事后从历史确认它其实跑过了）
  const acked = box.ack(m.messageId, { reply: '事后确认：已处理' })
  assert.equal(acked.state, MESSAGE_STATES.ACKED)
})

test('存储: 追加型日志，坏行不影响其余消息；事件文件在 root 下', () => {
  const root = tmpRoot()
  const box = openOutbox({ root })
  box.bind({ bindingId: 'a', codexThreadId: 'thread-a' })
  const good = box.enqueue({ bindingId: 'a', text: '正常消息' }).message

  fs.appendFileSync(box.eventsFile, '{ this is not json\n', 'utf8')

  const reopened = openOutbox({ root })
  assert.equal(reopened.getMessage(good.messageId).text, '正常消息')
  assert.equal(reopened.listMessages().length, 1)

  // 默认 root 在用户目录，不在仓库里
  const repoRoot = path.resolve(import.meta.dirname, '..')
  const defaultBox = openOutbox({})
  assert.equal(path.resolve(defaultBox.root).startsWith(repoRoot), false)
  assert.match(defaultBox.root, /\.dsh-codex-inbox$/)
})

// ------------------------------------------------- P1-1 记录边界：残尾不得吞掉新消息

test('P1-1 截断的残尾之后继续写入：新消息必须可查到，重开后两条都在', () => {
  const box = openOutbox({ root: tmpRoot() })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })
  const first = box.enqueue({ bindingId: 'b', text: 'preserved' }).message

  // 复现上次写入被截断：追加一个不带换行的半行
  fs.appendFileSync(box.eventsFile, '{"type":"enqueue","messageId":', 'utf8')

  const next = box.enqueue({ bindingId: 'b', text: 'after interrupted write' })
  assert.notEqual(next.message, undefined, '写入后必须能查到新 messageId，不能返回 undefined')
  assert.equal(next.message.text, 'after interrupted write')
  assert.equal(next.message.seq, first.seq + 1)

  const reopened = openOutbox({ root: box.root })
  assert.deepEqual(reopened.listMessages().map((m) => m.messageId), [first.messageId, next.message.messageId])
  assert.equal(reopened.getMessage(next.message.messageId).text, 'after interrupted write')

  // 边界修复只补换行、不改写历史，后续写入继续可用
  const third = reopened.enqueue({ bindingId: 'b', text: 'third' }).message
  assert.equal(third.seq, 3)
  assert.equal(openOutbox({ root: box.root }).listMessages().length, 3)
})

test('P1-1 完整但缺结尾换行的记录：不丢，后续写入也不串行', () => {
  const box = openOutbox({ root: tmpRoot() })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })
  const first = box.enqueue({ bindingId: 'b', text: 'first' }).message

  // 手工补一条"合法但缺结尾换行"的事件（模拟崩溃在最后一行末尾）
  const manualId = 'msg-manual-0001'
  fs.appendFileSync(box.eventsFile, JSON.stringify({
    type: 'enqueue', messageId: manualId, bindingId: 'b', codexThreadId: 'thread-b',
    text: 'complete but unterminated', deliver: 'queue', seq: 2, at: Date.now(),
  }), 'utf8')

  const third = box.enqueue({ bindingId: 'b', text: 'third' })
  assert.notEqual(third.message, undefined)

  const ids = openOutbox({ root: box.root }).listMessages().map((m) => m.messageId)
  assert.deepEqual(ids, [first.messageId, manualId, third.message.messageId])
  assert.equal(third.message.seq, 3)
})

// ------------------------------------------------- P1-2 跨进程写事务（真进程并发）

test('P1-2 多进程同键并发：只产生一条消息，只有一个 duplicate:false，seq 唯一', async () => {
  const root = tmpRoot()
  openOutbox({ root }).bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const results = await runTogether([0, 1, 2, 3].map(() => ({
    op: 'enqueue', root, lockTimeoutMs: 30000,
    args: { bindingId: 'b', text: 'same message', idempotencyKey: 'same-key' },
  })))

  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true])
  const ids = new Set(results.map((r) => r.result.message.messageId))
  assert.equal(ids.size, 1, '四个进程必须收敛到同一个 messageId')
  assert.equal(results.filter((r) => r.result.duplicate === false).length, 1, '只有第一个是新建')

  const messages = openOutbox({ root }).listMessages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].seq, 1)
  assert.equal(lockExists(root), false, '释放后不应残留锁文件')
})

test('P1-2 多进程不同键并发：四条的 seq 唯一且连续', async () => {
  const root = tmpRoot()
  openOutbox({ root }).bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const results = await runTogether([0, 1, 2, 3].map((i) => ({
    op: 'enqueue', root, lockTimeoutMs: 30000,
    args: { bindingId: 'b', text: 'message ' + i, idempotencyKey: 'key-' + i },
  })))

  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true])
  const messages = openOutbox({ root }).listMessages()
  assert.equal(messages.length, 4)
  assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3, 4])
  assert.equal(new Set(messages.map((m) => m.messageId)).size, 4)
})

test('P1-2 并发绑定：不同 id 都落地、同 id 同 thread 不重复、临时文件不残留', async () => {
  const root = tmpRoot()
  const results = await runTogether([
    { op: 'bind', root, lockTimeoutMs: 30000, args: { bindingId: 'a', codexThreadId: 'ta' } },
    { op: 'bind', root, lockTimeoutMs: 30000, args: { bindingId: 'b', codexThreadId: 'tb' } },
    { op: 'bind', root, lockTimeoutMs: 30000, args: { bindingId: 'a', codexThreadId: 'ta' } },
  ])
  assert.deepEqual(results.map((r) => r.ok), [true, true, true])

  const bindings = openOutbox({ root }).listBindings()
  assert.deepEqual(bindings.map((b) => b.bindingId), ['a', 'b'])
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'bindings.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw.bindings).sort(), ['a', 'b'])
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('.tmp-')), [])
})

test('P1-2 并发绑定冲突：同 id 不同 thread 只能成功一个', async () => {
  const root = tmpRoot()
  const results = await runTogether([
    { op: 'bind', root, lockTimeoutMs: 30000, args: { bindingId: 'x', codexThreadId: 't1' } },
    { op: 'bind', root, lockTimeoutMs: 30000, args: { bindingId: 'x', codexThreadId: 't2' } },
  ])
  assert.equal(results.filter((r) => r.ok).length, 1)
  const bad = results.filter((r) => r.ok !== true)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].reason, INBOX_REASONS.BINDING_THREAD_MISMATCH)
  assert.equal(openOutbox({ root }).listBindings().length, 1)
})

test('P1-2 死持有者的锁：明确报 lock-stale-holder 并 fail closed（不自动回收）', async () => {
  const root = tmpRoot()
  const box = openOutbox({ root, lockTimeoutMs: 3000 })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const deadPid = await deadProcessPid()
  writeLock(root, { token: 'dead-holder', pid: deadPid })
  const before = fs.readFileSync(lockPathOf(root), 'utf8')

  const error = throwsReason(() => box.enqueue({ bindingId: 'b', text: 'after dead holder' }), INBOX_REASONS.LOCK_STALE_HOLDER)
  assert.match(error.message, /Stop all writers/)
  assert.equal(fs.readFileSync(lockPathOf(root), 'utf8'), before, '不自动回收：死持有者的锁文件必须原样保留')
  assert.equal(fs.existsSync(path.join(root, 'messages.jsonl')), false, '零写入')

  // 文档给出的恢复步骤：确认没有写入者后人工删除，然后即可继续
  fs.unlinkSync(lockPathOf(root))
  const message = box.enqueue({ bindingId: 'b', text: 'after manual cleanup' }).message
  assert.equal(message.text, 'after manual cleanup')
})

test('P1-2 活持有者的锁：有限等待后报 lock-timeout，锁文件原样不动', () => {
  const root = tmpRoot()
  openOutbox({ root }).bind({ bindingId: 'b', codexThreadId: 'thread-b' })
  writeLock(root, { token: 'live-holder', pid: process.pid })   // 本进程活着 → 活持有者
  const before = fs.readFileSync(lockPathOf(root), 'utf8')

  const box = openOutbox({ root, lockTimeoutMs: 300 })
  const error = throwsReason(() => box.enqueue({ bindingId: 'b', text: 'cannot write' }), INBOX_REASONS.LOCK_TIMEOUT)
  assert.match(error.message, /live holder is never stolen/)
  assert.equal(fs.readFileSync(lockPathOf(root), 'utf8'), before, '活持有者的锁不得被改动或删除')
  assert.equal(fs.existsSync(path.join(root, 'messages.jsonl')), false, '拿不到锁就不该有任何写入')
})

test('P1-2 元数据无法确认（空 / 坏 JSON / 无 pid）：fail closed，绝不按时间回收', () => {
  const root = tmpRoot()
  // 给足超时：若实现是"超时就偷"，这里会变成 lock-timeout 或直接写成功
  const box = openOutbox({ root, lockTimeoutMs: 4000 })

  for (const content of ['', '{ not json', JSON.stringify({ token: 'no-pid-here' })]) {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(lockPathOf(root), content, 'utf8')
    const error = throwsReason(() => box.bind({ bindingId: 'b', codexThreadId: 't' }), INBOX_REASONS.LOCK_UNVERIFIED_HOLDER)
    assert.match(error.message, /refusing to reclaim it on a timer/)
    assert.equal(fs.readFileSync(lockPathOf(root), 'utf8'), content, '无法确认持有者的锁不得被改动/删除')
    assert.equal(fs.existsSync(path.join(root, 'bindings.json')), false, 'fail closed 时零写入')
  }
})

test('P1-2 活持有者期间真实进程只能等待：零写入、锁文件不变；释放后串行完成且同 key 仅一条', async () => {
  const root = tmpRoot()
  openOutbox({ root }).bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const releaseFile = path.join(root, 'holder-release')
  const holderSrc = 'const fs=require("node:fs"),path=require("node:path");'
    + 'const lock=process.argv[1],release=process.argv[2];'
    + 'fs.writeFileSync(lock, JSON.stringify({token:"live",pid:process.pid,host:"test",at:Date.now()}));'
    + 'const end=Date.now()+20000;while(!fs.existsSync(release)){if(Date.now()>end)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)};'
    + 'fs.unlinkSync(lock);'
  const holder = spawn(process.execPath, ['-e', holderSrc, lockPathOf(root), releaseFile], { stdio: 'ignore' })
  try {
    await waitFor(() => lockExists(root), 'holder lock')
    const heldBytes = fs.readFileSync(lockPathOf(root), 'utf8')

    // 两个真实进程同时尝试写：只能等
    const pending = runTogether([0, 1].map(() => ({
      op: 'enqueue', root, lockTimeoutMs: 30000,
      args: { bindingId: 'b', text: 'same message', idempotencyKey: 'same-key' },
    })))

    await sleep(800)
    assert.equal(fs.existsSync(path.join(root, 'messages.jsonl')), false, '活持有者期间必须零写入（无双写者）')
    assert.equal(fs.readFileSync(lockPathOf(root), 'utf8'), heldBytes, '持有者的锁文件不得被改动')

    fs.writeFileSync(releaseFile, '')
    await waitFor(() => !lockExists(root), 'holder release')

    const results = await pending
    assert.deepEqual(results.map((r) => r.ok), [true, true])
    assert.equal(results.filter((r) => r.result.duplicate === false).length, 1, '同 key 只有一个新建')
    const messages = openOutbox({ root }).listMessages()
    assert.equal(messages.length, 1, '同 key 并发只能产生一条消息')
    assert.equal(messages[0].seq, 1)
    assert.equal(lockExists(root), false)
  } finally {
    if (holder.exitCode === null) { fs.writeFileSync(releaseFile, ''); holder.kill(); await new Promise((r) => holder.on('exit', r)) }
  }
})

test('P1-2 高争用压测：6 个进程并发写，seq 唯一连续且不残留锁', async () => {
  const root = tmpRoot()
  openOutbox({ root }).bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const results = await runTogether([0, 1, 2, 3, 4, 5].map((i) => ({
    op: 'enqueue', root, lockTimeoutMs: 30000,
    args: { bindingId: 'b', text: 'contended ' + i, idempotencyKey: 'stress-' + i },
  })))

  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, true, true])
  const messages = openOutbox({ root }).listMessages()
  assert.equal(messages.length, 6)
  assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6], 'seq 必须唯一且连续（有双写者就会重复）')
  assert.equal(new Set(messages.map((m) => m.messageId)).size, 6)
  assert.equal(lockExists(root), false)
  assert.deepEqual(pendingFiles(root), [])
})

test('P1-2 锁用原子独占创建，释放后不残留锁与 pending', () => {
  const root = tmpRoot()
  const box = openOutbox({ root })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })
  box.enqueue({ bindingId: 'b', text: 'atomically published' })
  assert.equal(lockExists(root), false, '释放后锁文件应消失')
  assert.deepEqual(pendingFiles(root), [], 'pending 临时文件不得残留')
})

// ------------------------------------------------- P1-2 存储读错不得伪装成空收件箱

test('P1-2 报 stale 之前必须二次确认：读到"已死"后锁若已被正常释放，应重试而不是误报', async () => {
  const root = tmpRoot()
  const box = openOutbox({ root, lockTimeoutMs: 5000 })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })

  const deadPid = await deadProcessPid()
  writeLock(root, { token: 'released-holder', pid: deadPid })
  const lock = lockPathOf(root)

  // 确定性复现竞争窗口：第一次读到锁内容之后，持有者立刻正常释放（删除锁文件并退出）。
  // 旧实现会在此时直接判 stale 报错；正确实现必须二次确认（文件已不在 → 重试获取）。
  const original = fs.readFileSync
  let lockReads = 0
  fs.readFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      lockReads++
      const content = original.call(fs, file, ...args)
      if (lockReads === 1) fs.unlinkSync(lock)
      return content
    }
    return original.call(fs, file, ...args)
  }
  try {
    const message = box.enqueue({ bindingId: 'b', text: 'must survive holder release' }).message
    assert.equal(message.text, 'must survive holder release')
    assert.ok(lockReads >= 2, '报 stale 之前必须二次确认（本次只读到 ' + lockReads + ' 次）')
  } finally {
    fs.readFileSync = original
  }
  assert.equal(lockExists(root), false)
})

test('P1-2 绑定表损坏：明确报错，绝不退化成"没有绑定"', () => {
  const root = tmpRoot()
  fs.mkdirSync(root, { recursive: true })
  const bindingsFile = path.join(root, 'bindings.json')

  fs.writeFileSync(bindingsFile, '{ not json', 'utf8')
  const box = openOutbox({ root })
  throwsReason(() => box.listBindings(), INBOX_REASONS.STORE_CORRUPT)
  throwsReason(() => box.enqueue({ bindingId: 'b', text: 'x' }), INBOX_REASONS.STORE_CORRUPT)
  throwsReason(() => box.bind({ bindingId: 'b', codexThreadId: 't' }), INBOX_REASONS.STORE_CORRUPT)

  // 形状不对（数组）也算损坏
  fs.writeFileSync(bindingsFile, JSON.stringify({ formatVersion: 1, bindings: [] }), 'utf8')
  throwsReason(() => box.listBindings(), INBOX_REASONS.STORE_CORRUPT)

  // 只有"文件不存在"才是空收件箱
  fs.rmSync(bindingsFile)
  assert.deepEqual(openOutbox({ root }).listBindings(), [])
})

test('P1-2 正常路径结束后不残留锁与临时文件', () => {
  const root = tmpRoot()
  const box = openOutbox({ root })
  box.bind({ bindingId: 'b', codexThreadId: 'thread-b' })
  const message = box.enqueue({ bindingId: 'b', text: 'lifecycle' }).message
  box.markDelivered(message.messageId, { by: 'test' })
  box.ack(message.messageId, { reply: 'ok' })
  box.markFailed(box.enqueue({ bindingId: 'b', text: 'to fail' }).message.messageId, 'nope')
  box.markUnknown(box.enqueue({ bindingId: 'b', text: 'to unknown' }).message.messageId, 'unconfirmed')

  assert.equal(lockExists(root), false, '不得残留锁文件')
  assert.deepEqual(pendingFiles(root), [], '不得残留 pending 临时文件')
})
