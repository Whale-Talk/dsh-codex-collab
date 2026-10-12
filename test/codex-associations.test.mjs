/**
 * codex-associations.mjs / task-table.mjs 的真实行为测试（真文件、真多进程）。
 *
 * 覆盖 R1 的存储契约：绑定不可改投、来源校验、精确取值不串号、跨进程/跨"重启"可恢复、
 * 残尾与损坏的处理、命名空间隔离、路径安全，以及任务表淘汰不丢活任务。
 *
 * 跑法: node test/codex-associations.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  ASSOC_REASONS,
  MAX_ORIGIN_LENGTH,
  isValidNamespace,
  isValidOrigin,
  openAssociations,
  resolveAssocRoot,
} from '../harness/codex-associations.mjs'
import { DEFAULT_TASK_LIMIT, rememberTask } from '../harness/task-table.mjs'

const ASSOC_URL = pathToFileURL(path.resolve(import.meta.dirname, '..', 'harness', 'codex-associations.mjs')).href

const tmpRoots = []
const tmpRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-assoc-test-'))
  tmpRoots.push(dir)
  return dir
}

// 收尾清理：先校验解析后的绝对目标在系统临时根下且名字符合预期，再递归删除。
after(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  for (const dir of tmpRoots) {
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(tempRoot)) continue
    if (!path.basename(resolved).startsWith('codex-assoc-test-')) continue
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})
const throwsReason = (fn, reason) => {
  try {
    fn()
  } catch (e) {
    assert.equal(e.reason, reason, 'expected reason ' + reason + ' but got ' + e.reason + ' (' + e.message + ')')
    return e
  }
  throw new Error('expected a throw with reason ' + reason + ', but nothing was thrown')
}

// ---------------------------------------------------------------- 校验与默认值

test('isValidOrigin / isValidNamespace：只接受受约束的字符串', () => {
  assert.equal(isValidOrigin('thread-abc'), true)
  for (const bad of ['', '   ', null, undefined, 42, {}, 'a'.repeat(MAX_ORIGIN_LENGTH + 1), 'bad\u0000null', 'bad\nline']) {
    assert.equal(isValidOrigin(bad), false, 'should reject ' + JSON.stringify(bad))
  }
  assert.equal(isValidNamespace('default'), true)
  assert.equal(isValidNamespace('profile.1-a_b'), true)
  for (const bad of ['', 'a/b', '..', 'a\\b', 'x'.repeat(65), null]) {
    assert.equal(isValidNamespace(bad), false, 'should reject ' + JSON.stringify(bad))
  }
})

test('默认存储根在用户目录（绝不写仓库），命名空间非法直接抛错', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..')
  const root = resolveAssocRoot()
  assert.equal(path.resolve(root).startsWith(repoRoot), false)
  assert.match(root, /\.dsh-codex-task-assoc$/)
  assert.throws(() => openAssociations({ root: tmpRoot(), namespace: '../evil' }), /invalid association namespace/)
})

// ---------------------------------------------------------------- 绑定与取值

test('bind/fetch：来源匹配才返回记录；不匹配/缺来源/未知任务都拒绝', () => {
  const box = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: { kind: 'worker', cwd: 'E:\\p', lane: 'main' } })

  const ok = box.fetch({ originThreadId: 'origin-A', taskId: 't-1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.record.originThreadId, 'origin-A')
  assert.deepEqual(ok.record.target, { kind: 'worker', cwd: 'E:\\p', lane: 'main' })
  assert.equal(ok.record.status, 'accepted')

  assert.equal(box.fetch({ originThreadId: 'origin-B', taskId: 't-1' }).reason, ASSOC_REASONS.ORIGIN_MISMATCH)
  assert.equal(box.fetch({ taskId: 't-1' }).reason, ASSOC_REASONS.MISSING_ORIGIN)
  assert.equal(box.fetch({ originThreadId: 'origin-A', taskId: 'nope' }).reason, ASSOC_REASONS.UNKNOWN_TASK)
  throwsReason(() => box.bind({ originThreadId: '   ', taskId: 't-2' }), ASSOC_REASONS.INVALID_ORIGIN)
})

test('fetch 失败时不返回任何 record（缺来源/错来源/未知任务都不泄漏别人的结果）', () => {
  const box = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} })
  box.update('t-1', { status: 'done', result: 'secret-result' })

  const missing = box.fetch({ taskId: 't-1' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, ASSOC_REASONS.MISSING_ORIGIN)
  assert.equal(missing.record, undefined, '缺来源时绝不带出 record')

  const wrong = box.fetch({ originThreadId: 'origin-B', taskId: 't-1' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, ASSOC_REASONS.ORIGIN_MISMATCH)
  assert.equal(wrong.record, undefined, '错来源时绝不带出 record')

  const unknown = box.fetch({ originThreadId: 'origin-A', taskId: 't-nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, ASSOC_REASONS.UNKNOWN_TASK)
  assert.equal(unknown.record, undefined)

  assert.equal(JSON.stringify([missing, wrong, unknown]).includes('secret-result'), false, '失败响应里不得出现结果正文')
})

test('bind 不可改投：同一 taskId 换来源直接拒绝；同来源重复 bind 幂等', () => {
  const box = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  const first = box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: { kind: 'worker', cwd: 'E:\\p', lane: 'main' } })
  throwsReason(() => box.bind({ originThreadId: 'origin-B', taskId: 't-1', kind: 'task', target: {} }), ASSOC_REASONS.ORIGIN_CONFLICT)
  const again = box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} })
  assert.equal(again.createdAt, first.createdAt)
  assert.equal(box.count(), 1)
})

test('byOrigin：只列该来源的任务、最新在前、支持 limit（找回丢失 taskId 用）', async () => {
  const box = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} })
  await new Promise((r) => setTimeout(r, 5))
  box.bind({ originThreadId: 'origin-A', taskId: 't-2', kind: 'task', target: {} })
  box.bind({ originThreadId: 'origin-B', taskId: 't-3', kind: 'task', target: {} })

  const listed = box.byOrigin('origin-A')
  assert.deepEqual(listed.tasks.map((t) => t.taskId), ['t-2', 't-1'])
  assert.equal(box.byOrigin('origin-A', { limit: 1 }).tasks.length, 1)
  assert.deepEqual(box.byOrigin('origin-B').tasks.map((t) => t.taskId), ['t-3'])
  assert.equal(box.byOrigin('').ok, false)
  assert.equal(box.byOrigin('origin-A').tasks.every((t) => t.originThreadId === 'origin-A'), true)
})

test('update：终态/交付信息落盘；未知任务拒绝（不静默新建）', () => {
  const box = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} })
  const done = box.update('t-1', { status: 'done', result: '完成', stopReason: 'end_turn' })
  assert.equal(done.status, 'done')
  assert.equal(done.result, '完成')
  assert.equal(done.stopReason, 'end_turn')
  assert.ok(done.updatedAt >= done.createdAt)
  const delivered = box.update('t-1', { status: 'error', error: 'boom', delivered: true, reason: 'session-timeout' })
  assert.equal(delivered.delivered, true)
  assert.equal(delivered.error, 'boom')
  throwsReason(() => box.update('t-missing', { status: 'done' }), ASSOC_REASONS.UNKNOWN_TASK)
})

// ---------------------------------------------------------------- 持久化与恢复

test('跨进程/跨"重启"可恢复：新实例读同一 root 仍能按 origin+taskId 取值', () => {
  const root = tmpRoot()
  const first = openAssociations({ root, namespace: 'ns' })
  first.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: { kind: 'session', sessionId: 'session-x' } })
  first.update('t-1', { status: 'done', result: '结果正文' })

  const reopened = openAssociations({ root, namespace: 'ns' })
  const got = reopened.fetch({ originThreadId: 'origin-A', taskId: 't-1' })
  assert.equal(got.ok, true)
  assert.equal(got.record.status, 'done')
  assert.equal(got.record.result, '结果正文')
  assert.deepEqual(got.record.target, { kind: 'session', sessionId: 'session-x' })
})

test('命名空间隔离：不同 namespace 互不可见（文件分开）', () => {
  const root = tmpRoot()
  const a = openAssociations({ root, namespace: 'profile-a' })
  const b = openAssociations({ root, namespace: 'profile-b' })
  a.bind({ originThreadId: 'origin-A', taskId: 't-a', kind: 'task', target: {} })
  b.bind({ originThreadId: 'origin-A', taskId: 't-b', kind: 'task', target: {} })

  assert.equal(a.fetch({ originThreadId: 'origin-A', taskId: 't-a' }).ok, true)
  assert.equal(a.fetch({ originThreadId: 'origin-A', taskId: 't-b' }).reason, ASSOC_REASONS.UNKNOWN_TASK)
  assert.equal(b.fetch({ originThreadId: 'origin-A', taskId: 't-a' }).reason, ASSOC_REASONS.UNKNOWN_TASK)
  assert.notEqual(a.file, b.file)
  // 路径只由 root + 校验过的 namespace 组成：origin/taskId 不参与路径
  const names = fs.readdirSync(a.dir)
  assert.deepEqual(names.filter((n) => n.includes('origin-') || n.includes('t-')), [])
})

test('残尾不吞新记录；整文件损坏则明确报错（不降级成空记录）', () => {
  const root = tmpRoot()
  const box = openAssociations({ root, namespace: 'ns' })
  box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} })
  fs.appendFileSync(box.file, '{"type":"bind","originThreadId":"origin-A","taskId":', 'utf8')   // 半行（无换行）

  const next = box.bind({ originThreadId: 'origin-A', taskId: 't-2', kind: 'task', target: {} })
  assert.equal(next.taskId, 't-2')
  const reopened = openAssociations({ root, namespace: 'ns' })
  assert.deepEqual(reopened.byOrigin('origin-A').tasks.map((t) => t.taskId).sort(), ['t-1', 't-2'])

  // 整个文件是垃圾 → 读取与写入都必须抛 store-corrupt
  const broken = openAssociations({ root: tmpRoot(), namespace: 'ns' })
  fs.mkdirSync(broken.dir, { recursive: true })
  fs.writeFileSync(broken.file, 'not json at all\n%%%\n', 'utf8')
  throwsReason(() => broken.count(), ASSOC_REASONS.STORE_CORRUPT)
  throwsReason(() => broken.bind({ originThreadId: 'origin-A', taskId: 't-9', kind: 'task', target: {} }), ASSOC_REASONS.STORE_CORRUPT)
})

test('写入失败必须显式抛出（调用方据此放弃启动执行）', () => {
  const root = tmpRoot()
  const box = openAssociations({ root, namespace: 'ns' })
  // 把 namespace 目录换成文件，制造真实的写失败
  fs.rmSync(box.dir, { recursive: true, force: true })
  fs.writeFileSync(box.dir, 'not a directory', 'utf8')
  let error
  try { box.bind({ originThreadId: 'origin-A', taskId: 't-1', kind: 'task', target: {} }) } catch (e) { error = e }
  assert.notEqual(error, undefined, '写失败必须抛错，不能返回 undefined 假装成功')
  assert.equal(box.fetch({ originThreadId: 'origin-A', taskId: 't-1' }).ok, false)
})

// ---------------------------------------------------------------- 真多进程并发写入

const CHILD_SRC = `
const url = process.argv[1]
const payload = JSON.parse(process.argv[2])
;(async () => {
  const fs = await import('node:fs')
  const { openAssociations } = await import(url)
  try {
    if (payload.goFile !== undefined) {
      const end = Date.now() + 15000
      while (!fs.existsSync(payload.goFile)) {
        if (Date.now() > end) throw new Error('go barrier timed out')
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const box = openAssociations({ root: payload.root, namespace: payload.namespace, lockTimeoutMs: 30000 })
    const record = box.bind(payload.args)
    if (payload.update !== undefined) box.update(payload.args.taskId, payload.update)
    process.stdout.write(JSON.stringify({ ok: true, taskId: record.taskId }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, reason: e.reason, error: e.message }))
  }
})()
`

const runChild = (payload) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', CHILD_SRC, ASSOC_URL, JSON.stringify(payload)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code !== 0 || stdout.trim() === '') return reject(new Error('child exit=' + code + ' stderr=' + stderr.slice(0, 300)))
    resolve(JSON.parse(stdout))
  })
})

test('真多进程并发 bind：四条都落盘、日志不串行、折叠后记录完整', async () => {
  const root = tmpRoot()
  const goFile = path.join(root, 'go')
  fs.mkdirSync(root, { recursive: true })
  const children = [0, 1, 2, 3].map((i) => runChild({
    root, namespace: 'ns', goFile,
    args: { originThreadId: 'origin-A', taskId: 't-' + i, kind: 'task', target: { kind: 'worker', cwd: 'E:\\p', lane: 'lane-' + i } },
    update: { status: 'done', result: 'r-' + i },
  }))
  await new Promise((r) => setTimeout(r, 150))
  fs.writeFileSync(goFile, '')
  const results = await Promise.all(children)
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true])

  const box = openAssociations({ root, namespace: 'ns' })
  assert.equal(box.count(), 4)
  for (let i = 0; i < 4; i++) {
    const got = box.fetch({ originThreadId: 'origin-A', taskId: 't-' + i })
    assert.equal(got.ok, true, 't-' + i + ' 必须可取值')
    assert.equal(got.record.result, 'r-' + i)
    assert.equal(got.record.status, 'done')
  }
  assert.equal(fs.existsSync(path.join(box.dir, '.write.lock')), false)
})

// ---------------------------------------------------------------- 任务表淘汰

test('rememberTask：超限只淘汰终态任务，绝不淘汰仍在执行的任务', () => {
  const tasks = []
  for (let i = 0; i < DEFAULT_TASK_LIMIT; i++) tasks.push({ taskId: 'old-' + i, status: 'done' })
  const active = { taskId: 'active-1', status: 'accepted' }
  tasks.push(active)                                        // 表里 201 条，其中 1 条活任务
  rememberTask(tasks, { taskId: 'new-1', status: 'accepted' }, DEFAULT_TASK_LIMIT)
  assert.ok(tasks.length <= DEFAULT_TASK_LIMIT + 1, '不应无限增长：' + tasks.length)
  assert.equal(tasks.includes(active), true, '活任务必须留在表里（完成回调要能找到它）')
  assert.equal(tasks.some((t) => t.taskId === 'new-1'), true, '刚加入的任务不得被立刻淘汰')

  // 全是活任务时宁可超过上限，也不丢任何一个
  const allActive = []
  for (let i = 0; i < DEFAULT_TASK_LIMIT + 5; i++) allActive.push({ taskId: 'a-' + i, status: 'running' })
  rememberTask(allActive, { taskId: 'a-new', status: 'accepted' }, DEFAULT_TASK_LIMIT)
  assert.equal(allActive.length, DEFAULT_TASK_LIMIT + 6)
  assert.equal(allActive.every((t) => t.status === 'running' || t.taskId === 'a-new'), true)
})
