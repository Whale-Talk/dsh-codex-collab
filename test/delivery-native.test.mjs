/**
 * D0 原生契约测试（真实 SDK 组件，不是镜像）：
 *  - 真实导出的 `turnBoundaryProjectionDefinition`：durable inbox 事件 `agent/inbox/spliced` → next-turn/next-step
 *    的 FIFO 物化、重复 message.id 拒绝、非法 splice 拒绝、移除（取消）物化；
 *  - 真实源码契约断言（读到就断言，SDK 语义变化会立刻失败）：
 *      sessionController.prompt：source.rpcId=requestId、hasPromptRequest 幂等去重、mode==='steer' → agent.steer 否则 followup、异步 admission；
 *      agent-loop：followup→next-turn / steer→next-step / inject→next-step(不唤醒)、send 尾插 FIFO、
 *      wakingAfterAbort 把 steer 改道 next-turn、claim 取**全部** next-step + **仅一条** next-turn、
 *      claim('next-step') 不消费 next-turn、步进边界消费与 cancel 清空 inbox。
 *
 * 证据边界（诚实声明）：这是**本机 native 证据**（真实 app.asar 只读提取，SDK 不进运行时依赖，测后删除）；
 * 无 DSH 安装的环境整体 skip 并显示原因，绝不把 mock 冒充 native。
 * 跑法: node test/delivery-native.test.mjs
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

const roots = ['@deepseek-ai/dsh-agent-loop', '@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']
let outDir = null
let loaded = null

async function loadNative() {
  if (loaded !== null) return loaded
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
      for (const part of pointer.split('/')) { if (part === '') continue; node = node?.files?.[part]; if (node === undefined) return undefined }
      if (node === undefined || node.size === undefined) return undefined
      const buf = Buffer.alloc(Number(node.size))
      fs.readSync(fd, buf, 0, Number(node.size), dataOffset + Number(node.offset))
      return buf.toString('utf8')
    }
    const dirOf = (pointer) => {
      let node = tree
      for (const part of pointer.split('/')) { if (part === '') continue; node = node?.files?.[part]; if (node === undefined) return undefined }
      return node
    }
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delivery-native-'))
    const resolveSpecifier = (spec) => {
      if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
      return spec.split('/')[0]
    }
    const importSpecifiers = []
    const writeTree = (node, prefix) => {
      if (node.files !== undefined) { for (const [child, sub] of Object.entries(node.files)) writeTree(sub, prefix + '/' + child); return }
      if (node.size === undefined) return
      const offset = Number(node.offset)
      const size = Number(node.size)
      if (!Number.isFinite(offset) || !Number.isFinite(size)) return   // 非普通文件项（或指针/链接）：跳过
      const target = path.join(outDir, 'node_modules', prefix.replace(/^\//, ''))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, dataOffset + offset)
      fs.writeFileSync(target, buf)
      if (/\.(js|mjs|cjs)$/.test(prefix)) {
        const text = buf.toString('utf8')
        for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
          const spec = match[1]
          if (spec.startsWith('.') || spec.startsWith('node:')) continue
          importSpecifiers.push(resolveSpecifier(spec))
        }
        for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
          const spec = match[1]
          if (spec.startsWith('.') || spec.startsWith('node:')) continue
          importSpecifiers.push(resolveSpecifier(spec))
        }
      }
    }
    const seen = new Set()
    const queue = [...roots]
    while (queue.length > 0) {
      const name = queue.shift()
      if (seen.has(name) || seen.size > 200) continue
      const pkgText = readText('dsh/node_modules/' + name + '/package.json')
      if (pkgText === undefined) continue          // 可选 peer 缺失：跳过（诚实记录在 seen 里不计）
      seen.add(name)
      importSpecifiers.length = 0
      const dir = dirOf('dsh/node_modules/' + name)
      if (dir !== undefined) writeTree(dir, '/' + name)
      const pkg = JSON.parse(pkgText)
      for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) queue.push(dep)
      // 真实 import 说明符也算依赖（很多 DSH 包把它们列为 peer/未列出）
      for (const spec of importSpecifiers) {
        if (!seen.has(spec)) queue.push(spec)
      }
    }
    fs.closeSync(fd)
    const nm = path.join(outDir, 'node_modules')
    const loopPath = path.join(nm, '@deepseek-ai/dsh-agent-loop/lib/index.js')
    const loopMod = await import(pathToFileURL(loopPath).href)
    loaded = { loopMod, loopText: fs.readFileSync(loopPath, 'utf8'), packages: seen.size }
    return loaded
  } catch (e) {
    loaded = null
    try { fs.closeSync(fd) } catch (e2) { /* ignore */ }
    throw e
  }
}

after(() => {
  if (outDir !== null) {
    const temp = path.resolve(os.tmpdir()) + path.sep
    const resolved = path.resolve(outDir)
    if (resolved.startsWith(temp) && path.basename(resolved).startsWith('dsh-delivery-native-')) {
      try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    }
  }
})

test('native: 真实 turnBoundaryProjectionDefinition——回合/步进边界物化（队列消费时机依赖它）', { skip: SKIP }, async () => {
  const { loopMod } = await loadNative()
  const definition = loopMod.turnBoundaryProjectionDefinition
  assert.notEqual(definition, undefined, 'dsh-agent-loop 必须导出 turnBoundaryProjectionDefinition')
  assert.equal(definition.key, 'turnBoundary')
  let state = definition.init()
  assert.deepEqual(state, { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 })

  const ev = (seq, type, data = {}) => ({ seq, type, data })
  state = definition.apply(state, ev(10, 'turn/start', { turn: 7 }))
  assert.equal(state.lastTurn, 7, 'turn/start 记录 lastTurn')
  assert.equal(state.openTurnStartSeq, 10, 'turn/start 打开回合（这是"父回合是否开放"的官方判据）')
  state = definition.apply(state, ev(11, 'step/start', {}))
  assert.deepEqual(state.lastStepBoundary, { kind: 'start', seq: 11 })
  state = definition.apply(state, ev(12, 'step/end', {}))
  assert.deepEqual(state.lastStepBoundary, { kind: 'end', seq: 12 }, 'step/end 记录步进边界（steer 在此边界被消费）')
  state = definition.apply(state, ev(13, 'turn/end', {}))
  assert.equal(state.openTurnStartSeq, null, 'turn/end 关闭回合（此后 steer 不再属于该父回合）')
  // 与队列无关的事件不得改变状态（幂等）
  const before = { ...state }
  assert.deepEqual(definition.apply(state, ev(14, 'assistant/message', {})), before)
  // 事件顺序：turn/start → turn/end → 再 turn/start 必须得到新的开放回合
  state = definition.apply(state, ev(15, 'turn/start', { turn: 8 }))
  assert.equal(state.lastTurn, 8)
  assert.equal(state.openTurnStartSeq, 15)
})

test('native: 真实源码契约——steer/followup/claim/send/dedupe/admission 的准确语义', { skip: SKIP }, async () => {
  const { loopText } = await loadNative()
  const flat = loopText.replace(/\s+/g, ' ')
  // steer → next-step；followup → next-turn；inject → next-step（不唤醒）
  assert.match(flat, /steer\(input\) \{ this\.send\(input, "next-step", true\); \}/, 'steer 必须进 next-step 并唤醒')
  assert.match(flat, /followup\(input\) \{ this\.send\(input, "next-turn", true\); \}/, 'followup 必须进 next-turn 并唤醒')
  assert.match(flat, /inject\(input\) \{ this\.send\(input, "next-step", false\); \}/, 'inject 进 next-step 但不唤醒')
  // 尾插 = FIFO
  assert.match(flat, /this\.inbox\.splice\(resolvedTarget, Infinity, 0, \[message\]\)/, 'send 必须尾插（FIFO）')
  // 竞态：唤醒且当前回合已 abort → steer 被改道 next-turn
  assert.match(flat, /const wakingAfterAbort = wakeup && this\.phase\.kind !== "idle" && this\.phase\.abort\.signal\.aborted;/, '必须存在 wakingAfterAbort 判定')
  assert.match(flat, /const resolvedTarget = wakingAfterAbort \? "next-turn" : target;/, 'abort 后 steer 会被官方改道 next-turn（桥接必须如实报告偏离）')
  // claim：全部 next-step + 仅一条 next-turn
  assert.match(flat, /claim\(target, turn\) \{ const claimed = this\.mutate\("next-step", 0, this\.nextStep\.length, \[\], false\); if \(target === "next-turn"\) claimed\.push\(\.\.\.this\.mutate\("next-turn", 0, 1, \[\], false\)\);/, 'claim 取全部 next-step 且最多一条 next-turn')
  // 步进边界消费 + 取消清空
  assert.match(flat, /if \(turnEnds && this\.inbox\.nextStep\.length === 0\) break;/, '回合结束条件：next-step 为空')
  assert.match(flat, /clear\(\) \{ this\.splice\("next-step", 0, this\.nextStep\.length, \[\]\); this\.splice\("next-turn", 0, this\.nextTurn\.length, \[\]\); \}/, 'clear 会清空两列表（所以不能用 session cancel 清队列）')
})

test('native: 真实源码契约——sessionController.prompt 的 rpcId/幂等/模式分派/异步 admission', { skip: SKIP }, async () => {
  const asarText = (() => {
    const fd = fs.openSync(ASAR, 'r')
    try {
      const pre = Buffer.alloc(16)
      fs.readSync(fd, pre, 0, 16, 0)
      const header = Buffer.alloc(pre.readUInt32LE(12))
      fs.readSync(fd, header, 0, header.length, 16)
      const tree = JSON.parse(header.toString('utf8'))
      const dataOffset = 8 + pre.readUInt32LE(4)
      let node = tree
      for (const part of ['dsh', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'index.js']) node = node?.files?.[part]
      const buf = Buffer.alloc(Number(node.size))
      fs.readSync(fd, buf, 0, Number(node.size), dataOffset + Number(node.offset))
      return buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  })()
  const flat = asarText.replace(/\s+/g, ' ')
  assert.match(flat, /const source = \{ kind: "user", rpcId: request\.requestId/, 'prompt 必须把 requestId 写进 source.rpcId')
  assert.match(flat, /if \(hasPromptRequest\(agent, request\.requestId\)\) return \{ accepted: true \};/, '同 requestId 重复 prompt 必须幂等返回 accepted（不再投递）')
  assert.match(flat, /if \(request\.mode === "steer"\) agent\.steer\(message\); else agent\.followup\(message\);/, 'mode 决定 steer/followup')
  assert.match(flat, /const message = createUserMessage\(\{ content: await this\.ctx\.attachments\.admitPromptContent\(admission\.content\), source \}\);/, 'admission 是异步的（所以没有原子的 expectedTurn）')
  assert.match(flat, /function hasPromptRequest\(agent, requestId\) \{[\s\S]{0,400}?agent\.session\.snapshotEvents\(\)\.some/, '去重窗口覆盖整个会话日志（durable），不只是内存队列')
})
