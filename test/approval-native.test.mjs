/**
 * native harness：从本机官方 app.asar **只读**提取真实 cordis + dsh-user-approval + dsh-scope
 * 的依赖闭包到独立临时目录，用真实模块验证审批接缝语义：
 *   - cordis waterfall：prepend 次序 / 不调 next 否决整链 / 无监听者默认值
 *   - ApprovalService：放行链、单次 allowed-once、asked/decided 审计对同 id、
 *     our-answerer 独占（不调 next 时下游不被调用）
 *   - never 先拒（**零** answerer 调用）、无 open turn throw、signal→cancelled、
 *     非法返回/抛错归一 unavailable
 *   - scopeTarget 载体：未打标（根）监听器全局放行
 *
 * 证据边界（诚实声明）：这是**本机 native 证据**；SDK 不进入任何运行时依赖（只写临时目录，
 * 测后删除）。CI/无 DSH 安装的环境会整体 skip 并显示原因——绝不把 mock 结果冒充 native。
 * 跑法: node test/approval-native.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ASAR = process.env.DSH_ASAR || 'D:/Program Files (x86)/DSH/resources/app.asar'
let hasAsar = false
try { fs.accessSync(ASAR); hasAsar = true } catch (e) { hasAsar = false }
const SKIP = hasAsar ? false : 'app.asar 不在本机（DSH_ASAR=' + ASAR + '）——没有真实 SDK 就诚实跳过，绝不以 mock 冒充 native 证据'

const roots = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']
let nativePromise = null
let outDir = null

/** 只读 asar + 依赖闭包提取（byte-identical 拷贝；仅写临时目录）。 */
async function loadNative() {
  if (nativePromise !== null) return nativePromise
  nativePromise = (async () => {
    const fd = fs.openSync(ASAR, 'r')
    try {
      const pre = Buffer.alloc(16)
      fs.readSync(fd, pre, 0, 16, 0)
      const header = Buffer.alloc(pre.readUInt32LE(12))
      fs.readSync(fd, header, 0, header.length, 16)
      const tree = JSON.parse(header.toString('utf8'))
      const dataOffset = 8 + pre.readUInt32LE(4)
      const readText = (pointer) => {
        let node = tree
        for (const part of pointer.split('/')) { node = node.files?.[part]; if (node === undefined) return undefined }
        if (node === undefined || node.size === undefined) return undefined
        const size = Number(node.size)
        const buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, dataOffset + Number(node.offset))
        return buf.toString('utf8')
      }
      const dirOf = (pointer) => {
        let node = tree
        for (const part of pointer.split('/')) { node = node.files?.[part]; if (node === undefined) return undefined }
        return node
      }
      const writeTree = (node, prefix) => {
        if (node.files !== undefined) {
          for (const [child, sub] of Object.entries(node.files)) writeTree(sub, prefix + '/' + child)
          return
        }
        if (node.size === undefined) return
        const target = path.join(outDir, 'node_modules', prefix.replace(/^\//, ''))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const size = Number(node.size)
        const buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, dataOffset + Number(node.offset))
        fs.writeFileSync(target, buf)
      }
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-native-'))
      const seen = new Set()
      const queue = [...roots]
      while (queue.length > 0) {
        const name = queue.shift()
        if (seen.has(name) || seen.size > 150) continue
        const pkgText = readText('dsh/node_modules/' + name + '/package.json')
        if (pkgText === undefined) continue          // 可选 peer 缺失：跳过（诚实记录在 seen 里不计）
        seen.add(name)
        const dir = dirOf('dsh/node_modules/' + name)
        if (dir !== undefined) writeTree(dir, '/' + name)
        const pkg = JSON.parse(pkgText)
        for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) queue.push(dep)
      }
      fs.closeSync(fd)
      const nm = path.join(outDir, 'node_modules')
      const cordis = await import(pathToFileURL(path.join(nm, '@deepseek-ai/cordis/lib/index.js')).href)
      const approvalMod = await import(pathToFileURL(path.join(nm, '@deepseek-ai/dsh-user-approval/lib/index.js')).href)
      const scopeMod = await import(pathToFileURL(path.join(nm, '@deepseek-ai/dsh-scope/lib/index.js')).href)
      return { cordis, approvalMod, scopeMod, packages: seen.size, nm }
    } catch (e) {
      nativePromise = null
      throw e
    }
  })()
  return nativePromise
}

after(() => {
  if (outDir !== null) {
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

const makeSession = (withOpenTurn = true) => {
  const events = []
  if (withOpenTurn) events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } })
  return {
    get seq() { return events.length },
    eventAt(seq) { return events[Number(seq)] },
    append(type, data) { events.push({ seq: events.length, type, data }); return events.length },
    events,
  }
}

test('native: 真实 cordis waterfall——prepend 次序 / 不调 next 否决整链 / 空链默认值', { skip: SKIP }, async () => {
  const { cordis } = await loadNative()
  const ctx = new cordis.Context()
  const order = []
  ctx.on('probe/waterfall', async (value, next) => { order.push('first'); return '<' + (await next()) + '>' }, { prepend: true })
  ctx.on('probe/waterfall', async () => { order.push('second'); return 'VETO' })
  const out = await ctx.waterfall('probe/waterfall', { x: 1 }, async () => 'DEFAULT')
  assert.deepEqual(order, ['first', 'second'], 'prepend 让最先注册的先执行')
  assert.equal(out, '<VETO>', '不调 next 的监听者否决整链（含内置默认）')
  const empty = await ctx.waterfall('probe/empty', {}, async () => 'DEFAULT-ONLY')
  assert.equal(empty, 'DEFAULT-ONLY', '无监听者时落到内置 next')
})

test('native: 真实 ApprovalService——放行链/单次 allowed-once/审计对同 id/下游独占', { skip: SKIP }, async () => {
  const { cordis, approvalMod } = await loadNative()
  const ctx = new cordis.Context()
  const approval = new approvalMod.ApprovalService(ctx, { policy: 'ask' })
  const session = makeSession(true)
  const agent = { session }
  const calls = []
  ctx.on('approval/request', async (req, next) => { calls.push('ours'); return next() }, { prepend: true })
  ctx.on('approval/request', async () => { calls.push('human'); return 'allowed-once' })

  const outcome = await approval.request({ agent, toolName: 'bash', callId: 'c-native', reason: 'native probe' })
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(calls, ['ours', 'human'], 'prepend 注册的答复者先执行，且 next() 正确串到下游')

  const asked = session.events.filter((e) => e.type === 'approval/asked')
  const decided = session.events.filter((e) => e.type === 'approval/decided')
  assert.equal(asked.length, 1)
  assert.equal(decided.length, 1)
  assert.equal(asked[0].data.id, decided[0].data.id, 'asked/decided 审计对必须同 id')
  assert.equal(asked[0].data.callId, 'c-native')

  // 独占：我们的答复者不调 next（等价于谓词成立、直接决定）→ 下游不被调用
  const ctx2 = new cordis.Context()
  const approval2 = new approvalMod.ApprovalService(ctx2, { policy: 'ask' })
  const calls2 = []
  ctx2.on('approval/request', async () => { calls2.push('ours'); return 'allowed-once' }, { prepend: true })
  ctx2.on('approval/request', async () => { calls2.push('human'); return 'rejected' })
  const outcome2 = await approval2.request({ agent: { session: makeSession(true) }, toolName: 'bash', callId: 'c-take' })
  assert.equal(outcome2, 'allowed-once')
  assert.deepEqual(calls2, ['ours'], '直接决定时必须完全不触碰下游（不吞≠必调用）')
})

test('native: 真实 ApprovalService——never 先拒(零 answerer)/无 open turn throw/signal→cancelled/非法与抛错归一 unavailable', { skip: SKIP }, async () => {
  const { cordis, approvalMod } = await loadNative()
  const ctx = new cordis.Context()
  const approval = new approvalMod.ApprovalService(ctx, { policy: 'ask' })
  const calls = []
  ctx.on('approval/request', async (req, next) => { calls.push('asked:' + req.callId); return next() }, { prepend: true })
  ctx.on('approval/request', async (req, next) => {
    calls.push('human:' + req.callId)
    if (req.callId === 'c-rogue') return 'always'          // 非法词汇
    if (req.callId === 'c-throw') throw new Error('answerer blew up')
    return 'allowed-once'
  })

  // never 策略：在 waterfall 之前拒绝，答复者零调用
  const neverSession = makeSession(true)
  neverSession.append('approval/policy', { policy: 'never' })
  calls.length = 0
  const neverOutcome = await approval.request({ agent: { session: neverSession }, toolName: 'bash', callId: 'c-never' })
  assert.equal(neverOutcome, 'rejected')
  assert.equal(calls.length, 0, 'never 必须在 answerer 之前拒绝（一次都不调）')

  // 无 open turn → throw（asked 都不写）
  const idle = makeSession(false)
  await assert.rejects(() => approval.request({ agent: { session: idle }, toolName: 'bash', callId: 'c-idle' }), /open turn/)
  assert.equal(idle.events.length, 0, '前置失败不得写审计')

  // signal 中止 → cancelled（answerer 可能已被调用，但结果以官方 race 为准）
  const ac = new AbortController()
  const pending = approval.request({ agent: { session: makeSession(true) }, toolName: 'bash', callId: 'c-abort', signal: ac.signal })
  ac.abort()
  assert.equal(await pending, 'cancelled')

  // 非法返回值与抛错都归一 unavailable（fail closed）
  const rogue = await approval.request({ agent: { session: makeSession(true) }, toolName: 'bash', callId: 'c-rogue' })
  assert.equal(rogue, 'unavailable')
  const thrown = await approval.request({ agent: { session: makeSession(true) }, toolName: 'bash', callId: 'c-throw' })
  assert.equal(thrown, 'unavailable')
  assert.equal(calls.includes('asked:c-throw'), true)
})

test('native: scopeTarget 载体——未打标(根)监听器全局放行（root 注册可达的源码级证据）', { skip: SKIP }, async () => {
  const { cordis, scopeMod } = await loadNative()
  const agent = { session: makeSession(true) }
  const carrier = scopeMod.scopeTarget(agent, agent)
  assert.equal(typeof carrier[cordis.Context.filter], 'function', 'scopeTarget 产出过滤函数')
  assert.equal(carrier[cordis.Context.filter]({}), true, '未打标的 ctx（根监听器）必须被放行')
  assert.equal(cordis.Context.filter in agent, false, 'agent 本体不带过滤器（baseFilter 缺省）')
})
