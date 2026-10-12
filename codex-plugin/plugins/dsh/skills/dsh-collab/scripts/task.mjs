#!/usr/bin/env node
// Codex → DeepSeek Harness 任务脚本：POST 指令到桥网关，可轮询等待结果。
// 功能：--cwd 工作目录 / --lane 并行通道 / --model 模型别名 / --commit 完成后 Git 提交
//       --wait 等待结果（默认）/ --list 任务列表 / --cancel <taskId> / --status <taskId>
//       --origin <Codex对话id> 来源关联（跨回合精确收取；显式参数优先，其次本次调用的 CODEX_THREAD_ID）
//       --my-tasks 列出本来源登记过的任务（找回丢失的 taskId）/ --require-origin 无来源则如实拒绝
// 用法: node task.mjs --in "<指令>" [--cwd 目录] [--lane 名] [--model fast|pro] [--commit] [--timeout 秒] [--origin <id>]
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
  const out = { wait: true, timeoutSec: 600, instruction: '', cwd: '', lane: '', model: '', commit: false, list: false, cancel: '', status: '', sessions: '', sessionId: '', find: '', steer: false, force: false, origin: '', myTasks: false, requireOrigin: false }
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
    else if (a === '--sessions') { out.sessions = argv[++i] || '' }
    else if (a === '--session') { out.sessionId = argv[++i] || '' }
    else if (a === '--find') { out.find = argv[++i] || '' }
    else if (a === '--steer') { out.steer = true }
    else if (a === '--dry-run') { out.dryRun = true }
    else if (a === '--force') { out.force = true }
    else if (a === '--origin') {
      // 严格：来源 id 必须紧跟一个非空、不以 -- 开头的值；否则按用法错误处理（不静默降级）。
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.originError = '--origin 需要一个值（Codex 对话 id）'; continue }
      out.origin = v.trim()
    }
    else if (a === '--my-tasks') { out.myTasks = true }
    else if (a === '--require-origin') { out.requireOrigin = true }
    else { rest.push(a) }
  }
  if (!out.instruction && rest.length > 0) out.instruction = rest.join(' ')
  return out
}

/**
 * 解析来源对话 id：**显式参数优先**，其次本次调用的 CODEX_THREAD_ID（CLI 每次都是独立进程，
 * 因此这个环境变量确实是"这一次调用"的上下文）。绝不使用常驻进程的启动环境或"最近对话"推断。
 * @returns {{originThreadId?: string, source: 'explicit'|'env'|'none'}}
 */
function resolveOrigin(opts) {
  if (typeof opts.origin === 'string' && opts.origin.trim() !== '') return { originThreadId: opts.origin.trim(), source: 'explicit' }
  const fromEnv = typeof process.env.CODEX_THREAD_ID === 'string' ? process.env.CODEX_THREAD_ID.trim() : ''
  if (fromEnv !== '') return { originThreadId: fromEnv, source: 'env' }
  return { source: 'none' }
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

/**
 * 只读核验网关是否真的支持"持久来源绑定"（GET /status，不会派活）。
 * **不靠包版本猜**：旧网关会忽略 originThreadId 并照常 accepted → 产生"未绑定"任务。
 */
async function originBindingSupported() {
  try {
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status')
    const body = res.json
    return body !== null && typeof body === 'object'
      && body.capabilities !== null && typeof body.capabilities === 'object'
      && body.capabilities.originBinding !== null && typeof body.capabilities.originBinding === 'object'
      && body.capabilities.originBinding.supported === true
  } catch (e) {
    return false
  }
}

/** 只要这次调用真的会带上来源，就必须先确认网关支持；否则明确拒绝（绝不静默变成无关联派活）。 */
async function requireOriginSupport(origin) {
  if (origin.originThreadId === undefined) return true
  if (await originBindingSupported()) return true
  console.error('task.mjs: 该网关不支持持久来源绑定（/status 未上报 capabilities.originBinding）。旧网关会忽略 originThreadId 并照常 accepted，从而产生"未绑定"的任务。')
  console.error('已拒绝执行；请先升级 DSH profile 里的 dsh-codex-collab 插件，或去掉 --origin 使用旧的无关联模式。')
  return false
}

/** 网关自己给出的"明确拒绝"reason：原样透传（这些不是"成功了但没确认"）。 */
const REFUSAL_REASONS = new Set(['origin-required', 'origin-mismatch', 'invalid-origin', 'unknown-task', 'execution-state-unconfirmed'])

/** 网关必须**回显并匹配**我们请求的 originThreadId，才算确认了这次绑定/取值。 */
function originConfirmed(payload, origin) {
  return payload !== null && typeof payload === 'object' && payload.originThreadId === origin.originThreadId
}

/**
 * 能力检查通过 ≠ 这次绑定被确认：网关可能中途换过处理者（重载/旧 handler），接受了请求却没写关联。
 * 此时任务**可能已经执行**——既不能说成功，也绝不能重发。
 */
function unconfirmedExit(origin, extra) {
  console.error('task.mjs: 网关接受了请求但没有确认来源绑定（响应里没有匹配的 originThreadId）。这次任务可能已经在无关联模式下执行——**不要重发**；请用 --my-tasks/--status 复核，并检查 DSH profile 里的 dsh-codex-collab 插件版本。')
  console.error('task.mjs: 来源关联 originThreadId=' + origin.originThreadId + '（' + (origin.source === 'explicit' ? '--origin' : 'CODEX_THREAD_ID') + '）')
  console.log(JSON.stringify({ phase: 'unconfirmed', reason: 'origin-not-confirmed', resend: false, ...extra }))
  finish(8)
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
  const origin = resolveOrigin(opts)

  if (opts.originError !== undefined) {
    console.error('task.mjs: ' + opts.originError)
    finish(2)
  }

  // --my-tasks：只给来源时列出该对话登记过的任务，用来找回丢失的 taskId。
  // 没有任何来源（既没显式给，也没有本次调用的 CODEX_THREAD_ID）→ 如实拒绝，绝不猜"最近对话"。
  if (opts.myTasks) {
    if (origin.originThreadId === undefined) {
      console.error('task.mjs: --my-tasks 需要来源对话 id：请显式传 --origin <Codex对话id>，或确保本次调用的环境里有 CODEX_THREAD_ID')
      finish(2)
    }
    if (!(await requireOriginSupport(origin))) finish(2)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?originThreadId=' + encodeURIComponent(origin.originThreadId))
    if (res.json !== null && typeof res.json === 'object' && !originConfirmed(res.json, origin)) unconfirmedExit(origin, {})
    console.log(JSON.stringify(res.json, null, 2))
    finish(res.status === 200 ? 0 : 1)
  }

  if (opts.list) {
    if (!(await requireOriginSupport(origin))) finish(2)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/tasks' + (origin.originThreadId === undefined ? '' : '?originThreadId=' + encodeURIComponent(origin.originThreadId)))
    if (origin.originThreadId !== undefined && res.json !== null && typeof res.json === 'object' && !originConfirmed(res.json, origin)) unconfirmedExit(origin, {})
    console.log(JSON.stringify(res.json, null, 2))
    finish(0)
  }
  if (opts.cancel) {
    if (!(await requireOriginSupport(origin))) finish(2)
    const res = await request('POST', GATEWAY + '/api/dsh-bridge/cancel', { taskId: opts.cancel, force: opts.force === true, ...(origin.originThreadId === undefined ? {} : { originThreadId: origin.originThreadId }) })
    if (origin.originThreadId !== undefined && res.json !== null && typeof res.json === 'object' && res.json.cancelled === true && !originConfirmed(res.json, origin)) unconfirmedExit(origin, { taskId: opts.cancel })
    console.log(JSON.stringify(res.json, null, 2))
    finish(res.status === 409 ? 5 : 0)
  }
  if (opts.status) {
    if (!(await requireOriginSupport(origin))) finish(2)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(opts.status) + (origin.originThreadId === undefined ? '' : '&originThreadId=' + encodeURIComponent(origin.originThreadId)))
    const body = res.json
    const refused = body !== null && typeof body === 'object' && typeof body.reason === 'string' && REFUSAL_REASONS.has(body.reason)
    // 精确取值必须由网关**确认来源**；没确认就不算读到（也绝不把网关 body 里的结果打出来）。
    if (origin.originThreadId !== undefined && !refused && !originConfirmed(body, origin)) {
      unconfirmedExit(origin, { taskId: opts.status })
    }
    console.log(JSON.stringify(body, null, 2))
    // 非 200 = 没读到任务（未知 taskId / 已关联但缺来源 / 来源不匹配）→ 明确非零。
    // 读到任务（含旧的无来源未关联任务）仍是 0，兼容不变。
    finish(res.status === 200 ? 0 : 6)
  }
  if (opts.sessions) {
    const res = await request('POST', GATEWAY + '/api/dsh-bridge/sessions', { query: opts.sessions, inspect: true, limit: 20 })
    if (res.json === null || typeof res.json !== 'object') {
      console.error('task.mjs: 网关返回 ' + res.status + '，响应不是 JSON —— profile 里的插件可能还是旧版本（session 接口需要 0.1.2+）')
      console.error(String(res.text || '').slice(0, 200))
      finish(1)
    }
    console.log(JSON.stringify(res.json, null, 2))
    const items = Array.isArray(res.json.items) ? res.json.items : []
    if (items.length === 0 && Array.isArray(res.json.candidates) && res.json.candidates.length > 0) {
      console.error('未命中。候选（改用 --session <id>，或换个关键词）:')
      for (const c of res.json.candidates) console.error('  ' + c.sessionId + '  ' + c.snippet + (c.score === undefined ? '' : '  score=' + c.score))
      console.error('提示: 验证命中用 --dry-run，不要投递消息去试探。')
    }
    finish(items.length > 0 ? 0 : 4)
  }

  const instruction = opts.instruction.trim()
  const cwd = (opts.cwd || process.env.DSH_BRIDGE_CWD || '').trim()
  const sessionId = (opts.sessionId || '').trim()
  const find = (opts.find || '').trim()
  const sessionTarget = sessionId !== '' ? { sessionId } : (find !== '' ? { sessionQuery: find } : null)

  // --dry-run：只解析目标、回显命中结果，什么都不投递。验证"这条查询会命中哪条会话"就用它，
  // 绝不要投递一条消息去试探（那会落进用户会话并跑成回合，污染对话）。
  if (opts.dryRun) {
    if (instruction === '' && sessionTarget === null && cwd === '') {
      console.error('用法: node task.mjs --dry-run (--find "<标题关键词>" | --session <会话id> | --cwd <目录>)')
      finish(2)
    }
    const res = await request('POST', GATEWAY + '/api/dsh-bridge/task', {
      instruction: instruction === '' ? '(dry-run)' : instruction,
      dryRun: true,
      ...(sessionTarget === null ? (cwd ? { cwd } : {}) : sessionTarget),
    })
    console.log(JSON.stringify(res.json, null, 2))
    if (res.json === null || typeof res.json !== 'object') finish(1)
    if (res.json.resolved !== true) {
      if (Array.isArray(res.json.candidates) && res.json.candidates.length > 0) {
        console.error('未命中。候选（改用 --session <id>，或换个关键词）:')
        for (const c of res.json.candidates) console.error('  ' + c.sessionId + '  ' + c.snippet + (c.score === undefined ? '' : '  score=' + c.score))
      }
      finish(4)
    }
    finish(0)
  }

  if (!instruction) {
    console.error('用法: node task.mjs --in "<指令>" [--cwd 目录] [--lane 名] [--model fast|pro] [--commit] [--timeout 秒] [--no-wait] [--origin <Codex对话id>]')
    console.error('      node task.mjs --in "<指令>" (--session <会话id> | --find "<标题关键词>") [--steer]   # 投递进已有会话')
    console.error('查找: node task.mjs --sessions "<标题关键词>"   # 只读列出候选, 拿 sessionId 再派活')
    console.error('      node task.mjs --dry-run (--find "<关键词>" | --session <id>)   # 只解析目标, 不投递（验证命中用这个）')
    console.error('管理: node task.mjs --list [--origin <id>] | --status <taskId> [--origin <id>] | --cancel <taskId> [--force] [--origin <id>]')
    console.error('来源: node task.mjs --my-tasks [--origin <id>]   # 列出该 Codex 对话登记过的任务（找回丢失的 taskId）')
    console.error('      来源 id 优先取 --origin，其次本次调用的环境变量 CODEX_THREAD_ID；--require-origin 表示没有来源就拒绝派活。')
    console.error('退出码: 0 成功 / 1 失败 / 2 用法（含缺少来源） / 3 超时 / 4 会话未命中或不唯一 / 5 session 目标取消被拒 / 6 查询不到该任务（未知或来源不匹配）')
    finish(2)
  }
  if (sessionTarget !== null && (cwd !== '' || opts.commit)) {
    console.error('task.mjs: --session/--find 不能与 --cwd/--commit 同时使用（已有会话自带工作目录，本工具不替它提交）')
    finish(2)
  }
  if (sessionTarget === null && cwd) {
    try { fs.mkdirSync(cwd, { recursive: true }) } catch (e) {
      console.error('task.mjs: 无法创建目录 ' + cwd + ':', e.message)
      finish(2)
    }
  }
  const history = sessionTarget === null ? readHistory() : []
  // --require-origin：要求这次派活必须带上来源关联；拿不到来源就如实拒绝（不静默降级成无关联）。
  if (opts.requireOrigin === true && origin.originThreadId === undefined) {
    console.error('task.mjs: --require-origin 已指定，但拿不到来源对话 id：请显式传 --origin <Codex对话id>，或确保本次调用的环境里有 CODEX_THREAD_ID。')
    console.error('（不会降级成"无关联派活"——那会让结果无法按来源精确收回。）')
    finish(2)
  }
  // 要带来源就必须先确认网关真的支持（只读 GET，不派活）；不支持 → 零执行拒绝。
  if (!(await requireOriginSupport(origin))) finish(2)
  const posted = await request('POST', GATEWAY + '/api/dsh-bridge/task', {
    instruction,
    ...(origin.originThreadId === undefined ? {} : { originThreadId: origin.originThreadId }),
    ...(sessionTarget === null
      ? {
          ...{ history },
          ...(cwd ? { cwd } : {}),
          ...(opts.lane ? { lane: opts.lane } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        }
      : {
          ...sessionTarget,
          ...(opts.steer ? { deliver: 'steer' } : {}),
        }),
  })
  const task = posted.json
  if (task === null || typeof task !== 'object') {
    console.error('task.mjs: 网关返回 ' + posted.status + '，响应不是 JSON —— profile 里的插件可能还是旧版本（session 目标需要 0.1.2+）')
    console.error(String(posted.text || '').slice(0, 200))
    finish(1)
  }
  if (origin.originThreadId !== undefined && task.taskId !== undefined && !originConfirmed(task, origin)) {
    // 网关接受了请求，却没有回显我们的来源：绑定**未被确认**（可能已经无关联地执行了）→ 不要重发。
    unconfirmedExit(origin, { taskId: task.taskId })
  }
  if (origin.originThreadId !== undefined) {
    console.error('task.mjs: 来源关联 originThreadId=' + origin.originThreadId + '（' + (origin.source === 'explicit' ? '--origin' : 'CODEX_THREAD_ID') + '）')
  }
  console.log(JSON.stringify({ phase: task.taskId === undefined ? 'rejected' : 'submitted', ...task }))
  if (task.reason === 'session-ambiguous' || task.reason === 'session-query-empty') {
    console.error('task.mjs: ' + (task.error || task.reason))
    if (Array.isArray(task.candidates) && task.candidates.length > 0) {
      console.error('候选（改用 --session <id> 指定其一）:')
      for (const c of task.candidates) console.error('  ' + c.sessionId + '  ' + c.snippet)
    }
    finish(4)
  }
  if (task.taskId === undefined) {
    // 网关明确拒绝了这次派活（例如同一通道还有在途任务、来源非法）——非零退出，别让调用方以为派出去了。
    console.error('task.mjs: 派活被拒绝: ' + (task.error || 'unknown error') + (task.reason === undefined ? '' : '（reason=' + task.reason + '）'))
    finish(task.reason === 'worker-bucket-busy' || task.reason === 'reviewer-bucket-busy' ? 7 : 1)
  }
  if (posted.status !== 202 || task.status === 'error') {
    console.error('task.mjs: ' + (task.error || task.reason || 'submission failed'))
    finish(1)
  }
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
      // delivered=true 表示 prompt 已被那条会话接受（进了它的队列）：即便我们等超时了，
      // 消息也可能会跑，**不要重发**（重发会让同一份内容在用户会话里出现两次）。
      if (status.status === 'error' && status.delivered === true) {
        console.error('注意: 消息已投递进该会话的队列（delivered=true），只是我们没等到它开跑。不要重发；可用 --status ' + task.taskId + ' 继续观察。')
      }
      if (status.status === 'done') {
        // session 目标的记忆就在那条会话里，不再往协作历史里塞一份。
        if (sessionTarget === null) {
          appendHistory([
            { role: 'user', text: instruction },
            { role: 'assistant', text: status.result || '(无输出)' },
          ])
        }
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
