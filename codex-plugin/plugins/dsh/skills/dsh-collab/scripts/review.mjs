#!/usr/bin/env node
// Codex → DeepSeek Harness 评审脚本：把代码变更 diff 交给独立评审子代理。
// 评审员会读 cwd 真实文件、静态审查、并实际运行构建/测试验证可跑通。
// 用法: node review.mjs --cwd <目录> [--diff <diff 文本|@文件|git|git-staged>] [--focus <审查重点>] [--timeout 秒]
import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'

function parseArgs(argv) {
  const out = { timeoutSec: 900, cwd: '', diff: '', focus: '' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cwd') { out.cwd = argv[++i] || '' }
    else if (a === '--diff') { out.diff = argv[++i] || '' }
    else if (a === '--focus') { out.focus = argv[++i] || '' }
    else if (a === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v)) out.timeoutSec = v }
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

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cwd = (opts.cwd || '').trim()
  if (!cwd) {
    console.error('用法: node review.mjs --cwd <目录> [--diff git|git-staged|@文件|"diff 文本"] [--focus <重点>] [--timeout 秒]')
    finish(2)
  }
  if (!fs.existsSync(cwd)) {
    console.error('review.mjs: 目录不存在: ' + cwd)
    finish(2)
  }
  const diff = resolveDiff(cwd, opts.diff)
  console.log('[review] diff 长度: ' + diff.length + ' 字符')
  const posted = await request('POST', GATEWAY + '/api/dsh-bridge/review', {
    cwd, diff,
    ...(opts.focus ? { focus: opts.focus } : {}),
  })
  const task = posted.json
  console.log(JSON.stringify({ phase: 'submitted', ...task }))
  if (posted.status !== 202 || task.status === 'error') finish(posted.status === 202 ? 0 : 1)

  const deadline = Date.now() + opts.timeoutSec * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId))
    const status = res.json
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
      console.log(JSON.stringify({ phase: 'finished', ...status }))
      console.log('=== 评审报告 ===')
      console.log(status.result || status.error || '(无内容)')
      finish(status.status === 'done' ? 0 : 1)
    }
  }
  console.error('等待超时(' + opts.timeoutSec + 's)，评审仍在后台执行:')
  console.error(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId))
  finish(3)
}

function finish(code) {
  try { process.stderr.write = () => true } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch((e) => { console.error('review.mjs 失败:', (e && e.message) || e); finish(1) })
