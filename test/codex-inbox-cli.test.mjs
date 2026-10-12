/**
 * codex-inbox.mjs 的**进程级**测试（P2-3）。
 *
 * 重点不是"函数返回什么"，而是"进程怎么结束、有没有悄悄改存储"：
 *   - 带值旗标缺值 / 未知旗标 → exit 2，且发生在打开存储之前（不新建默认目录，不改已有状态）；
 *   - `ack --reply`（缺值）不得把 true 当 undefined 照常确认；
 *   - `send --key`（缺值）不得静默丢掉幂等键；
 *   - `--root`（缺值）不得回落到真实默认目录。
 * 每个子进程都把 USERPROFILE 指向一次性假 home，用来证明"没有碰真实默认目录"。
 *
 * 跑法: node test/codex-inbox-cli.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const CLI = path.resolve(import.meta.dirname, '..', 'mcp', 'codex-inbox.mjs')

const runCli = (args, options = {}) => {
  const fakeHome = options.fakeHome === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inbox-home-')) : options.fakeHome
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, DSH_CODEX_INBOX_DIR: '' },
  })
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout === null || result.stdout === undefined ? '' : result.stdout,
    stderr: result.stderr === null || result.stderr === undefined ? '' : result.stderr,
    fakeHome,
  }
}

const json = (text) => JSON.parse(text)

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inbox-cli-'))

// 收尾清理：先校验解析后的绝对目标在系统临时根下且名字符合预期，再递归删除。
after(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  for (const dir of fs.readdirSync(os.tmpdir())) {
    if (!dir.startsWith('codex-inbox-cli-') && !dir.startsWith('codex-inbox-home-')) continue
    const resolved = path.resolve(path.join(os.tmpdir(), dir))
    if (!resolved.startsWith(tempRoot)) continue
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

const defaultRootIn = (fakeHome) => path.join(fakeHome, '.dsh-codex-inbox')

test('P2-3 带值旗标缺值：exit 2，且不碰存储（含 --root 不得回落默认目录）', () => {
  for (const args of [
    ['capabilities', '--root'],                       // --root 缺值：最危险的一种
    ['bind', '--binding', 'b', '--thread'],           // --thread 缺值
    ['send', '--binding', 'b', '--text', 'hi', '--key'],   // --key 缺值：不得静默丢幂等键
    ['ack', 'msg-1', '--reply'],                      // --reply 缺值：不得把 true 当 undefined
    ['list', '--limit'],
    ['fail', 'msg-1', '--reason'],
  ]) {
    const result = runCli(args)
    assert.equal(result.code, 2, '期望 exit 2: ' + args.join(' ') + ' → 实际 ' + result.code + ' / ' + result.stderr.slice(0, 200))
    assert.equal(fs.existsSync(defaultRootIn(result.fakeHome)), false, '缺值时不得新建默认收件箱目录: ' + args.join(' '))
  }
})

test('P2-3 未知旗标：exit 2，且不碰存储', () => {
  const result = runCli(['capabilities', '--nope', 'x'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /未知旗标 --nope/)
  assert.equal(fs.existsSync(defaultRootIn(result.fakeHome)), false)
})

test('P2-3 布尔旗标仍可用：--help / --json 不带值不报错', () => {
  const help = runCli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stderr, /codex-inbox/)

  const root = tmpRoot()
  const jsonFlag = runCli(['capabilities', '--json', '--root', root])
  assert.equal(jsonFlag.code, 0)
  assert.equal(json(jsonFlag.stdout).deliveryMode, 'inbox')
})

test('P2-3 值域校验也发生在打开存储之前', () => {
  // 用一个**尚不存在**的子目录，才能证明"校验失败时没有创建存储"
  const root = path.join(tmpRoot(), 'store')
  const bad = runCli(['send', '--binding', 'b', '--text', 'hi', '--deliver', 'now', '--root', root])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /--deliver 只接受 queue 或 steer/)
  assert.equal(fs.existsSync(root), false, '值域不合法时不该创建存储')

  const badLimit = runCli(['list', '--limit', 'abc', '--root', root])
  assert.equal(badLimit.code, 2)
  assert.equal(fs.existsSync(root), false)
})

test('P2-3 缺值被拒后状态不变：原本 queued 的消息仍是 queued，且没有多出消息', () => {
  const root = tmpRoot()
  const bind = runCli(['bind', '--binding', 'b', '--thread', 'thread-b', '--root', root])
  assert.equal(bind.code, 0)
  const send = runCli(['send', '--binding', 'b', '--text', 'canary', '--key', 'k1', '--root', root])
  assert.equal(send.code, 0)
  const messageId = json(send.stdout).messageId

  const before = fs.readFileSync(path.join(root, 'messages.jsonl'), 'utf8')
  const badAck = runCli(['ack', messageId, '--reply', '--root', root])
  assert.equal(badAck.code, 2)
  const badSendKey = runCli(['send', '--binding', 'b', '--text', 'another', '--key', '--root', root])
  assert.equal(badSendKey.code, 2)

  assert.equal(fs.readFileSync(path.join(root, 'messages.jsonl'), 'utf8'), before, '被拒的调用不得改写事件日志')
  const status = runCli(['status', messageId, '--root', root])
  assert.equal(status.code, 0)
  assert.equal(json(status.stdout).message.state, 'queued', 'ack 缺值不得把它确认掉')
  const list = runCli(['list', '--root', root])
  assert.equal(json(list.stdout).count, 1, '缺值的 send 不得新增消息')
})

test('P2-3 正常路径仍然可用（回归）', () => {
  const root = tmpRoot()
  assert.equal(runCli(['bind', '--binding', 'b', '--thread', 'thread-b', '--source', 'session-x', '--root', root]).code, 0)
  const send = runCli(['send', '--binding', 'b', '--text', 'hello', '--key', 'k1', '--root', root])
  assert.equal(send.code, 0)
  const messageId = json(send.stdout).messageId

  const dup = runCli(['send', '--binding', 'b', '--text', 'hello', '--key', 'k1', '--root', root])
  assert.equal(dup.code, 0)
  assert.equal(json(dup.stdout).duplicate, true)

  const conflict = runCli(['send', '--binding', 'b', '--text', 'changed', '--key', 'k1', '--root', root])
  assert.equal(conflict.code, 4)

  assert.equal(runCli(['delivered', messageId, '--by', 'codex-side', '--root', root]).code, 0)
  const ack = runCli(['ack', messageId, '--reply', 'echo hello', '--turn', 'turn-1', '--root', root])
  assert.equal(ack.code, 0)
  assert.equal(json(ack.stdout).message.reply, 'echo hello')

  const pending = runCli(['pending', '--root', root])
  assert.equal(pending.code, 0)
  assert.equal(json(pending.stdout).count, 0)

  const unbound = runCli(['send', '--binding', 'nope', '--text', 'x', '--root', root])
  assert.equal(unbound.code, 3)
})
