#!/usr/bin/env node
// Codex → DeepSeek Harness 任务脚本：POST 指令到桥网关，可轮询等待结果。
// 功能：--cwd 工作目录 / --lane 并行通道 / --model 模型别名 / --commit 完成后 Git 提交
//       --wait 等待结果（默认）/ --list 任务列表 / --cancel <taskId> / --status <taskId>
// 用法: node task.mjs --in "<指令>" [--cwd 目录] [--lane 名] [--model fast|pro] [--commit] [--timeout 秒]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'

// 历史文件候选位置（按优先顺序）：Codex 沙箱可能拒绝写入工作目录，逐级降级。
// 可用环境变量 DSH_BRIDGE_HISTORY 指定唯一位置。
const HISTORY_CANDIDATES = process.env.DSH_BRIDGE_HISTORY
  ? [process.env.DSH_BRIDGE_HISTORY]
  : [
      path.join('D:', path.sep, 'Harness', '.dsh-collab', 'history.ndjson'),
      path.join(process.env.USERPROFILE || '.', '.dsh-collab', 'history.ndjson'),
      path.join(process.env.TEMP || '.', 'dsh-collab-history.ndjson'),
    ]
const HISTORY_MAX = 40

function parseArgs(argv) {
  const out = { wait: true, timeoutSec: 600, instruction: '', cwd: '', lane: '', model: '', commit: false, list: false, cancel: '', status: '' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') { out.instruction = argv[++i] || '' }
    else if (a === '--cwd') { out.cwd = argv[++i] || '' }
    else if (a === '--lane') { out.lane = argv[++i] || '' }
    else if (a === '--model') { out.model = argv[++i] || '' }
    else if (a === '--commit') { out.commit = true }
    else if (a === '--wait') { out.wait = true }
    else if (a === '--no-wait') { out.wait = false }
    else if (a === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v)) out.timeoutSec = v }
    else if (a === '--list') { out.list = true }
    else if (a === '--cancel') { out.cancel = argv[++i] || '' }
    else if (a === '--status') { out.status = argv[++i] || '' }
    else { rest.push(a) }
  }
  if (!out.instruction && rest.length > 0) out.instruction = rest.join(' ')
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 请求层：node:http + Connection: close，避免 undici keep-alive 退出断言 ----
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
        try { json = text === '' ? null : JSON.parse(text) } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, text, json })
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// ---- 历史：多位置读取合并 + 逐级降级写入 ----
function readHistory() {
  const entries = []
  const seen = new Set()
  for (const file of HISTORY_CANDIDATES) {
    try {
      if (!fs.existsSync(file)) continue
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const h = JSON.parse(t)
          if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string') {
            const key = h.role + ':' + h.text
            if (!seen.has(key)) { seen.add(key); entries.push(h) }
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  while (entries.length > HISTORY_MAX) entries.shift()
  return entries
}

function appendHistory(newEntries) {
  const all = readHistory().concat(newEntries)
  while (all.length > HISTORY_MAX) all.shift()
  const content = all.map((h) => JSON.stringify(h)).join('\n') + '\n'
  for (const file of HISTORY_CANDIDATES) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return
    } catch (e) { /* try next candidate */ }
  }
  // 全部位置不可写：不阻塞任务结果，仅提示
  console.error('task.mjs: 协作历史无法落盘（沙箱限制），跨进程记忆将在本次会话后丢失')
}

function gitCommit(cwd, message) {
  try {
    const isRepo = (() => {
      try { execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe', windowsHide: true }); return true } catch (e) { return false }
    })()
    if (!isRepo) {
      console.log('[commit] ' + cwd + ' 不是 git 仓库，跳过自动提交')
      return null
    }
    execFileSync('git', ['-C', cwd, 'add', '-A'], { stdio: 'pipe', windowsHide: true })
    const changed = (() => {
      try { execFileSync('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { stdio: 'pipe', windowsHide: true }); return false } catch (e) { return true }
    })()
    if (!changed) {
      console.log('[commit] 无变更，跳过提交')
      return null
    }
    const msg = message.replace(/\r?\n/g, ' ').slice(0, 200)
    execFileSync('git', ['-C', cwd, 'commit', '-m', '[dsh-collab] ' + msg], { stdio: 'pipe', windowsHide: true })
    const hash = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { stdio: 'pipe', windowsHide: true }).toString('utf8').trim()
    console.log('[commit] 已提交: ' + hash)
    return hash
  } catch (e) {
    console.error('[commit] 提交失败:', e.message)
    return null
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.list) {
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/tasks')
    console.log(JSON.stringify(res.json, null, 2))
    finish(0)
  }
  if (opts.cancel) {
    const res = await request('POST', GATEWAY + '/api/dsh-bridge/cancel', { taskId: opts.cancel })
    console.log(JSON.stringify(res.json, null, 2))
    finish(0)
  }
  if (opts.status) {
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(opts.status))
    console.log(JSON.stringify(res.json, null, 2))
    finish(0)
  }

  const instruction = opts.instruction.trim()
  if (!instruction) {
    console.error('用法: node task.mjs --in "<指令>" [--cwd 目录] [--lane 名] [--model fast|pro] [--commit] [--timeout 秒] [--no-wait]')
    console.error('管理: node task.mjs --list | --status <taskId> | --cancel <taskId>')
    finish(2)
  }
  const cwd = (opts.cwd || process.env.DSH_BRIDGE_CWD || '').trim()
  if (cwd) {
    try { fs.mkdirSync(cwd, { recursive: true }) } catch (e) {
      console.error('task.mjs: 无法创建目录 ' + cwd + ':', e.message)
      finish(2)
    }
  }
  const history = readHistory()
  const posted = await request('POST', GATEWAY + '/api/dsh-bridge/task', {
    instruction, history,
    ...(cwd ? { cwd } : {}),
    ...(opts.lane ? { lane: opts.lane } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  })
  const task = posted.json
  console.log(JSON.stringify({ phase: 'submitted', ...task }))
  if (posted.status !== 202 || task.status === 'error') finish(posted.status === 202 ? 0 : 1)
  if (!opts.wait) finish(0)

  const deadline = Date.now() + opts.timeoutSec * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId))
    const status = res.json
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
      console.log(JSON.stringify({ phase: 'finished', ...status }))
      console.log('=== DeepSeek 汇报 ===')
      console.log(status.result || status.error || '(无内容)')
      if (status.status === 'done') {
        appendHistory([
          { role: 'user', text: instruction },
          { role: 'assistant', text: status.result || '(无输出)' },
        ])
        if (opts.commit && cwd) gitCommit(cwd, '[task ' + task.taskId + '] ' + instruction)
      }
      finish(status.status === 'done' ? 0 : 1)
    }
  }
  console.error('等待超时(' + opts.timeoutSec + 's)，任务仍在后台执行。可用 status 接口继续查询:')
  console.error(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId))
  finish(3)
}

// 退出收尾：先静默 stderr（抑制 Node 退出时的 libuv 断言噪音），再按码退出。
// 任务结果以 stdout 中 "=== DeepSeek 汇报 ===" 为准。
function finish(code) {
  try { process.stderr.write = () => true } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch((e) => { console.error('task.mjs 失败:', (e && e.message) || e); finish(1) })
