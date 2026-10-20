#!/usr/bin/env node
// Codex → DeepSeek Harness 评审脚本：把代码变更 diff 交给独立评审子代理。
// 评审员会读 cwd 真实文件、静态审查、并实际运行构建/测试验证可跑通。
// 用法: node review.mjs --cwd <目录> [--diff <diff 文本|@文件|git|git-staged>] [--focus <审查重点>] [--timeout 秒]
//       [--origin <Codex 对话 id>] [--model auto|fast|pro|default|<精确 model id>] [--provider <provider id>]
//       [--model-fallback | --no-model-fallback]
//
// 评审与编码使用**同一套模型契约**（服务端任务 kind=review、执行目标 worker）：
//   - 默认 auto（优先兼容 DeepSeek）；
//   - 显式 provider+model 是一对身份，必须成对发送；
//   - 旧网关没有 capabilities.modelRouting / originBinding 时 → **零派活**拒绝，绝不忽略新参数照常执行。
import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'

function parseArgs(argv) {
  const out = { timeoutSec: 900, cwd: '', diff: '', focus: '', origin: '', model: '', provider: '', valueError: undefined }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cwd') { out.cwd = argv[++i] || '' }
    else if (a === '--diff') { out.diff = argv[++i] || '' }
    else if (a === '--focus') { out.focus = argv[++i] || '' }
    else if (a === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v)) out.timeoutSec = v }
    // ---- 模型路由（与 task.mjs 同一契约）----
    else if (a === '--model') {
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.valueError = '--model 需要一个值（auto/fast/pro/default 或精确 model id）'; continue }
      out.model = v.trim()
    }
    else if (a === '--provider') {
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.valueError = '--provider 需要一个值（已注册的 provider id）'; continue }
      out.provider = v.trim()
    }
    else if (a === '--model-fallback') { out.modelFallback = true }
    else if (a === '--no-model-fallback') { out.modelFallback = false }
    // ---- 来源（显式，跨回合精确收取）----
    else if (a === '--origin') {
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.valueError = '--origin 需要一个值（Codex 对话 id）'; continue }
      out.origin = v.trim()
    }
    else { rest.push(a) }
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// node:http + Connection: close，避免 undici keep-alive 退出断言
function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { reject(e); return }
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers = { 'Content-Type': 'application/json', Connection: 'close' }
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload)
    const req = http.request({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 80,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text === '' ? null : JSON.parse(text) } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode || 0, text, json })
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function resolveDiff(cwd, diffSpec) {
  if (!diffSpec || diffSpec === '' || diffSpec === 'git') {
    try {
      return execFileSync('git', ['-C', cwd, 'diff'], { stdio: 'pipe', windowsHide: true, maxBuffer: 1024 * 1024 * 4 }).toString('utf8')
    } catch (e) { return '' }
  }
  if (diffSpec === 'git-staged' || diffSpec === 'git-cached') {
    try {
      return execFileSync('git', ['-C', cwd, 'diff', '--cached'], { stdio: 'pipe', windowsHide: true, maxBuffer: 1024 * 1024 * 4 }).toString('utf8')
    } catch (e) { return '' }
  }
  if (diffSpec.startsWith('@')) {
    const file = diffSpec.slice(1)
    try { return fs.readFileSync(file, 'utf8') } catch (e) {
      console.error('review.mjs: 无法读取 diff 文件 ' + file)
      finish(2)
    }
  }
  return diffSpec
}

/** 来源解析：显式 --origin 优先，其次本次调用的 CODEX_THREAD_ID（绝不推断"最近对话"）。 */
function resolveOrigin(opts) {
  if (typeof opts.origin === 'string' && opts.origin.trim() !== '') return { originThreadId: opts.origin.trim(), source: 'explicit' }
  const fromEnv = typeof process.env.CODEX_THREAD_ID === 'string' ? process.env.CODEX_THREAD_ID.trim() : ''
  if (fromEnv !== '') return { originThreadId: fromEnv, source: 'env' }
  return { source: 'none' }
}

/** 只读能力探测（GET /status，不派活）。 */
async function capabilityOf() {
  try {
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status')
    const body = res.json
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'status-http-' + res.status }
    if (body === null || typeof body !== 'object' || body.capabilities === null || typeof body.capabilities !== 'object') return { ok: false, reason: 'no-capabilities' }
    return { ok: true, capabilities: body.capabilities }
  } catch (e) {
    return { ok: false, reason: 'status-unreachable' }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.valueError !== undefined) { console.error('review.mjs: ' + opts.valueError); finish(2) }
  const cwd = (opts.cwd || '').trim()
  if (!cwd) {
    console.error('用法: node review.mjs --cwd <目录> [--diff git|git-staged|@文件|"diff 文本"] [--focus <重点>] [--timeout 秒] [--origin <id>] [--model ...] [--provider <id>] [--model-fallback|--no-model-fallback]')
    finish(2)
  }
  if (!fs.existsSync(cwd)) {
    console.error('review.mjs: 目录不存在: ' + cwd)
    finish(2)
  }
  const origin = resolveOrigin(opts)
  const usesModelControl = opts.model !== '' || opts.provider !== '' || opts.modelFallback !== undefined
  const cap = await capabilityOf()
  if (!cap.ok) {
    // 连能力都读不到：派活前拒绝（旧网关/未装载插件），绝不忽略新参数照常执行。
    console.error('review.mjs: 无法确认网关能力（' + cap.reason + '）——评审派活拒绝，未执行任何投递。')
    finish(2)
  }
  if (origin.originThreadId === undefined) {
    console.error('review.mjs: 评审派活需要**显式来源**（--origin 或本次调用的 CODEX_THREAD_ID），否则无法跨回合精确收取。')
    finish(2)
  }
  if (cap.capabilities.originBinding === undefined || cap.capabilities.originBinding.supported !== true) {
    console.error('review.mjs: 该网关不支持持久来源绑定（capabilities.originBinding）——评审派活拒绝，未执行任何投递。')
    finish(2)
  }
  if (usesModelControl && (cap.capabilities.modelRouting === undefined || cap.capabilities.modelRouting.supported !== true)) {
    console.error('review.mjs: 该网关未声明 capabilities.modelRouting（旧网关）——带模型参数的评审派活拒绝，未执行任何投递。')
    finish(2)
  }
  const diff = resolveDiff(cwd, opts.diff)
  console.log('[review] diff 长度: ' + diff.length + ' 字符；来源 ' + origin.originThreadId + '（' + origin.source + '）')
  const posted = await request('POST', GATEWAY + '/api/dsh-bridge/review', {
    cwd, diff,
    ...(opts.focus ? { focus: opts.focus } : {}),
    originThreadId: origin.originThreadId,
    ...(opts.provider !== '' ? { provider: opts.provider } : {}),
    ...(opts.model !== '' ? { model: opts.model } : {}),
    ...(opts.modelFallback === undefined ? {} : { modelFallback: opts.modelFallback }),
  })
  const task = posted.json
  console.log(JSON.stringify({ phase: 'submitted', ...task }))
  if (task !== null && typeof task === 'object' && task.taskId !== undefined && task.originThreadId !== origin.originThreadId) {
    // 网关接受了请求但没回显我们的来源：绑定**未被确认**（可能已执行）→ 不重发。
    console.error('review.mjs: 网关未回显匹配的来源 originThreadId —— 绑定未被确认，**不要重发**。')
    finish(1)
  }
  if (posted.status !== 202 || task === null || typeof task !== 'object' || task.status === 'error') finish(posted.status === 202 ? 0 : 1)

  const deadline = Date.now() + opts.timeoutSec * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId) + '&originThreadId=' + encodeURIComponent(origin.originThreadId))
    const status = res.json
    if (status === null || typeof status !== 'object') continue
    if (status.status === 'unknown' && status.recovered === true) {
      // 执行状态未知：如实报告，绝不重发、不无限等
      console.error('review.mjs: 任务执行状态未确认（网关重启/重载），不重发；原任务: ' + task.taskId)
      console.log(JSON.stringify({ phase: 'unconfirmed', ...status }))
      finish(1)
    }
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
      console.log(JSON.stringify({ phase: 'finished', ...status }))
      if (status.route !== undefined) console.log('[review] route: ' + JSON.stringify(status.route))
      console.log('=== 评审报告 ===')
      console.log(status.result || status.error || '(无内容)')
      finish(status.status === 'done' ? 0 : 1)
    }
  }
  console.error('等待超时(' + opts.timeoutSec + 's)，评审仍在后台执行:')
  console.error(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId) + '&originThreadId=' + encodeURIComponent(origin.originThreadId))
  finish(3)
}

function finish(code) {
  try { process.stderr.write = () => true } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch((e) => { console.error('review.mjs 失败:', (e && e.message) || e); finish(1) })
