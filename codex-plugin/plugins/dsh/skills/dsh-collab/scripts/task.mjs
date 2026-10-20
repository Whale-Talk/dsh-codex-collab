#!/usr/bin/env node
// Codex → DeepSeek Harness 任务脚本：POST 指令到桥网关，可轮询等待结果。
// 功能：--cwd 工作目录 / --lane 并行通道 / --model 模型别名 / --commit 完成后 Git 提交
//       --wait 等待结果（默认）/ --list 任务列表 / --cancel <taskId> / --status <taskId>
//       --origin <Codex对话id> 来源关联（跨回合精确收取；显式参数优先，其次本次调用的 CODEX_THREAD_ID）
//       --my-tasks 列出本来源登记过的任务（找回丢失的 taskId）/ --require-origin 无来源则如实拒绝
// 审批委托：--approval-key-init|--approval-key-rotate（离线初始化/轮换控制凭据，仓库外私有目录）
//       --delegate（会话目标派活时显式开启委托；预检凭据/能力/来源，失败零执行）
//       --approvals [--grant <id>] [--wait-approval 秒] / --approval-show <key>
//       --approve <key> --grant <id> --fingerprint <fp> / --reject <key>（同前；仅单次）
//       --revoke-grant <grantId>；审批类退出码 9=needs-approval（任务非终态、等审批）
// 用法: node task.mjs --in "<指令>" [--cwd 目录] [--lane 名] [--model fast|pro] [--commit] [--timeout 秒] [--origin <id>]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { initControlKey, controlHeaderValue } from '../../../../../../harness/codex-approvals.mjs'

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
  const out = { wait: true, timeoutSec: 600, instruction: '', cwd: '', lane: '', model: '', commit: false, list: false, cancel: '', status: '', statusWait: false, sessions: '', sessionId: '', find: '', steer: false, parent: '', expectedTurn: 0, force: false, origin: '', myTasks: false, requireOrigin: false, approvals: false, approvalShow: '', approvalKey: '', grantId: '', fingerprint: '', idem: '', decision: '', revokeGrant: '', renewGrant: '', renewNow: false, extendSec: 0, taskId: '', reason: '', keyInit: false, keyRotate: false, delegate: false, delegateTtl: 0, delegateLease: 0, authorization: '', approvalWait: 0, models: false, provider: '', modelFallback: undefined }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') { out.instruction = argv[++i] || '' }
    else if (a === '--cwd') { out.cwd = argv[++i] || '' }
    else if (a === '--lane') { out.lane = argv[++i] || '' }
    else if (a === '--model') {
      // 新开放精确 model id 后同样要有缺值语义（--model --something 不能被当成 model id）。
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.valueError = '--model 需要一个值（auto/fast/pro/default 或精确 model id）'; continue }
      out.model = v.trim()
    }
    else if (a === '--commit') { out.commit = true }
    else if (a === '--wait') { out.wait = true }
    else if (a === '--no-wait') { out.wait = false }
    else if (a === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v)) out.timeoutSec = v }
    else if (a === '--list') { out.list = true }
    else if (a === '--cancel') { out.cancel = argv[++i] || '' }
    else if (a === '--status') { out.status = argv[++i] || '' }
    else if (a === '--status-wait') { out.statusWait = true }
    else if (a === '--sessions') { out.sessions = argv[++i] || '' }
    else if (a === '--session') { out.sessionId = argv[++i] || '' }
    else if (a === '--find') { out.find = argv[++i] || '' }
    else if (a === '--steer') { out.steer = true; out.deliver = 'steer' }
    else if (a === '--parent') { out.parent = argv[++i] || ''; out.deliver = 'steer' }
    else if (a === '--expected-turn') { const v = Number(argv[++i]); if (Number.isInteger(v) && v > 0) out.expectedTurn = v }
    else if (a === '--dry-run') { out.dryRun = true }
    else if (a === '--force') { out.force = true }
    // ---- 动态模型路由（M2）----
    else if (a === '--models') { out.models = true }
    else if (a === '--provider') {
      // 精确 provider 是 model 的身份对的一半：缺值必须显式报错，绝不静默回落 auto。
      const v = argv[++i]
      if (v === undefined || v.trim() === '' || v.startsWith('--')) { out.valueError = '--provider 需要一个值（已注册的 provider id）'; continue }
      out.provider = v.trim()
    }
    else if (a === '--model-fallback') { out.modelFallback = true }
    else if (a === '--no-model-fallback') { out.modelFallback = false }
    // ---- 审批委托 ----
    else if (a === '--approval-key-init') { out.keyInit = true }
    else if (a === '--approval-key-rotate') { out.keyRotate = true }
    else if (a === '--delegate') { out.delegate = true }
    else if (a === '--delegate-ttl') { const v = Number(argv[++i]); if (Number.isFinite(v) && v > 0) out.delegateTtl = v }
    else if (a === '--delegate-lease') { const v = Number(argv[++i]); if (Number.isFinite(v) && v > 0) out.delegateLease = v }
    else if (a === '--authorization') { out.authorization = argv[++i] || '' }
    else if (a === '--approvals') { out.approvals = true }
    else if (a === '--approval-show') { out.approvalShow = argv[++i] || '' }
    else if (a === '--approve') { out.decision = 'approve-once'; out.approvalKey = argv[++i] || '' }
    else if (a === '--reject') { out.decision = 'reject'; out.approvalKey = argv[++i] || '' }
    else if (a === '--revoke-grant') { out.revokeGrant = argv[++i] || '' }
    else if (a === '--renew-grant') { out.renewGrant = argv[++i] || '' }
    else if (a === '--renew') { out.renewNow = true }
    else if (a === '--extend') { const v = Number(argv[++i]); if (Number.isFinite(v) && v > 0) out.extendSec = v }
    else if (a === '--task') { out.taskId = argv[++i] || '' }
    else if (a === '--grant') { out.grantId = argv[++i] || '' }
    else if (a === '--fingerprint') { out.fingerprint = argv[++i] || '' }
    else if (a === '--idem') { out.idem = argv[++i] || '' }
    else if (a === '--reason') { out.reason = argv[++i] || '' }
    else if (a === '--wait-approval') { const v = Number(argv[++i]); if (Number.isFinite(v)) out.approvalWait = Math.min(Math.max(v, 0), 30) }
    else if (a === '--origin') {
      // 来源 id 必须紧跟一个非空、不以 -- 开头的值；否则按用法错误处理（不静默降级）。
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
function request(method, urlStr, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { reject(e); return }
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers = { 'Content-Type': 'application/json', Connection: 'close', ...(extraHeaders || {}) }
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

/**
 * **唯一的有界等待路径**（第四轮修正）：初次 `--in` 默认等待与 `--status-wait` 共用。
 *   - 显式来源时每个 status 都带 originThreadId，并**逐次**严格核对回显（缺失/错源 → 退出码 8，不透 result、不重发）；
 *   - 按响应里的 grant 字段做**自适应认证续租**（轮询间隔 = 租约剩余/3；不传 extendSec 只续租约）；
 *   - `needs-approval` 视为非终态 → 立即返回（调用方据此退出 9），绝不阻塞等 done；
 *   - 终态 `done`/`error`/`cancelled`/`unknown` 原样返回，语义与旧实现一致；无委托任务不做任何续租（旧兼容）。
 * 返回 `{ reason: 'terminal'|'needs-approval'|'timeout', status }`。
 */
async function awaitTerminal({ taskId, origin, grantId, grantLeaseUntil, timeoutSec, waitHeaders }) {
  const deadline = Date.now() + timeoutSec * 1000
  const originQs = origin.originThreadId === undefined ? '' : '&originThreadId=' + encodeURIComponent(origin.originThreadId)
  const renewOrigin = encodeURIComponent(origin.originThreadId === undefined ? '' : origin.originThreadId)
  let effectiveGrantId = typeof grantId === 'string' && grantId !== '' ? grantId : ''
  let leaseUntil = Number.isFinite(grantLeaseUntil) ? grantLeaseUntil : 0
  let pollMs = leaseUntil > 0 ? Math.min(3000, Math.max(250, Math.floor(Math.max(leaseUntil - Date.now(), 0) / 3))) : 3000
  let receiptDeadline = 0   // 回执等待上限（≤30s），与父任务结果等待分离（第四轮首次验收修正 C）
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + originQs)
    const status = res.json
    if (status === null || typeof status !== 'object') continue
    // 逐次核对来源回显（网关的明确拒绝原样透传，不算"未确认"）
    if (origin.originThreadId !== undefined) {
      const refused = typeof status.reason === 'string' && REFUSAL_REASONS.has(status.reason)
      if (!refused && !originConfirmed(status, origin)) unconfirmedExit(origin, { taskId })
    }
    // 自适应认证续租（只用响应里的 grant 字段；未委托任务没有这些字段 → 完全不续）
    if (typeof status.grantId === 'string' && status.grantId !== '') effectiveGrantId = status.grantId
    if (Number.isFinite(status.grantLeaseUntil)) leaseUntil = status.grantLeaseUntil
    if (waitHeaders !== null && effectiveGrantId !== '') {
      const remaining = leaseUntil === 0 ? null : leaseUntil - Date.now()
      if (remaining !== null && remaining < Math.max(800, pollMs)) {
        const renewed = await request('GET', GATEWAY + '/api/dsh-bridge/approvals?originThreadId=' + renewOrigin + '&taskId=' + encodeURIComponent(taskId) + '&grantId=' + encodeURIComponent(effectiveGrantId), undefined, waitHeaders)
        const g = renewed.json !== null && typeof renewed.json === 'object' && Array.isArray(renewed.json.grants) ? renewed.json.grants[0] : null
        if (g !== null && Number.isFinite(g.leaseUntil)) leaseUntil = g.leaseUntil
      }
    }
    const after = leaseUntil === 0 ? null : leaseUntil - Date.now()
    pollMs = after === null ? 3000 : Math.min(3000, Math.max(250, Math.floor(Math.max(after, 0) / 3)))
    // 回执（第四轮首次验收修正 C）：只等**回执自身**的终态，绝不等父任务的 done。
    // observed / deviated / unconfirmed 都是回执终态；pending 到点如实返回（不重发、不套父结果等待）。
    if (status.deliver === 'steer' || typeof status.receiptState === 'string') {
      const state = status.receiptState
      if (state === 'observed' || state === 'deviated' || state === 'unconfirmed') return { reason: 'receipt-terminal', status }
      if (receiptDeadline === 0) receiptDeadline = Date.now() + Math.min(30000, Math.max(1000, timeoutSec * 1000))
      if (Date.now() >= receiptDeadline) return { reason: 'receipt-pending', status }
      continue
    }
    if (status.status === 'needs-approval') return { reason: 'needs-approval', status }
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled' || status.status === 'unknown') {
      return { reason: 'terminal', status }
    }
  }
  return { reason: 'timeout', status: null }
}

/**
 * 回执终态输出（第四轮首次验收修正 C）：回执只报自身状态，绝不等到父任务的 done。
 * observed/pending → 退出 0；deviated/unconfirmed → 退出 4（明确"未确认/偏离"，但**不要重发**）。
 */
function receiptOutcome(st, reason, origin) {
  const state = st !== null && typeof st === 'object' ? st.receiptState : undefined
  const phase = reason === 'receipt-pending' ? 'receipt-pending'
    : (state === 'observed' ? 'receipt-observed' : (state === 'deviated' ? 'receipt-deviated' : 'receipt-unconfirmed'))
  console.log(JSON.stringify({ phase, resultScope: 'parent-task', resend: false, ...st }))
  console.error('这是**补充回执**（resultScope=parent-task, receiptState=' + String(state) + '）：不代表父任务已完成，也不是独立答案。')
  console.error('  * 父任务最终结果: node task.mjs --status ' + String(st.parentTaskId || '') + (origin !== undefined && origin.originThreadId !== undefined ? ' --origin ' + origin.originThreadId : '') + ' --status-wait')
  if (phase === 'receipt-pending') console.error('  * 仍在观察寿命内继续求证（**不要重发**）；稍后再查一次即可。')
  if (phase === 'receipt-deviated') console.error('  * 官方把这条补充落进了另一个回合（偏离目标父回合）——**不要重发**。')
  if (phase === 'receipt-unconfirmed') console.error('  * 未能证明自身 rpcId 落进父回合——**不要重发**。')
  finish(phase === 'receipt-observed' || phase === 'receipt-pending' ? 0 : 4)
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
  // 模型/provider 缺值：在**任何网络请求之前**退出（绝不让 --model 末尾静默变 auto）。
  if (opts.valueError !== undefined) {
    console.error('task.mjs: ' + opts.valueError)
    finish(2)
  }

  // ---- 控制凭据离线初始化/轮换（不发任何网络请求；写仓库/工作区之外的私有目录；raw key 不回显）----
  if (opts.keyInit || opts.keyRotate) {
    try {
      const created = initControlKey({ force: opts.keyRotate === true })
      console.log(JSON.stringify({
        ok: true,
        path: created.path,
        keyFp: created.fp8,
        rotated: created.rotated,
        note: 'raw key 不回显。host/MCP/CLI 都只按此路径内部读取，HTTP 用 X-Dsh-Control 传**私有 raw key** 做认证；服务端只存域分离单向摘要（不能用于登录）。'
          + (created.rotated ? ' 轮换会改变指纹，全部旧 grant 立即失效（等价撤销）。' : ' 文件已存在时不会覆盖（用 --approval-key-rotate 显式轮换）。'),
      }, null, 2))
      finish(0)
    } catch (e) {
      console.error('task.mjs: 控制凭据初始化失败: ' + e.message)
      finish(1)
    }
  }

  // ---- 审批查询/决定/撤销/续期（全部要求控制凭据 + 显式 --origin/--task 定位；退出码 9=等待审批）----
  if (opts.approvals || opts.approvalShow !== '' || opts.decision !== '' || opts.revokeGrant !== '' || opts.renewGrant !== '') {
    const headers = controlHeaderValue()
    if (headers === null) {
      console.error('task.mjs: 本机没有有效控制凭据，审批能力默认关闭。先运行: node task.mjs --approval-key-init')
      finish(2)
    }
    // origin/task 只用于定位；服务端会与 pending/grant 硬核对。缺一即拒绝（避免跨来源泄露/误续租）。
    const needTaskCtx = () => {
      if (origin.originThreadId === undefined || opts.taskId === '') {
        console.error('task.mjs: 审批操作必须显式给 --origin <对话id> 与 --task <taskId>（定位用；服务端会硬核对，不能只靠 grantId）。')
        finish(2)
      }
      return { originThreadId: origin.originThreadId, taskId: opts.taskId }
    }
    if (opts.revokeGrant !== '') {
      const ctx = needTaskCtx()
      const res = await request('POST', GATEWAY + '/api/dsh-bridge/approvals/grants/' + encodeURIComponent(opts.revokeGrant) + '/revoke', { ...ctx, grantId: opts.revokeGrant, reason: opts.reason !== '' ? opts.reason : 'revoked via CLI' }, headers)
      console.log(JSON.stringify(res.json, null, 2))
      finish(res.status === 200 && res.json !== null && res.json.ok === true ? 0 : 1)
    }
    if (opts.renewGrant !== '') {
      const ctx = needTaskCtx()
      const res = await request('POST', GATEWAY + '/api/dsh-bridge/approvals/grants/' + encodeURIComponent(opts.renewGrant) + '/renew', { ...ctx, grantId: opts.renewGrant, ...(opts.extendSec > 0 ? { extendSec: Math.min(opts.extendSec, 3600) } : {}) }, headers)
      console.log(JSON.stringify(res.json, null, 2))
      finish(res.status === 200 && res.json !== null && res.json.ok === true ? 0 : 1)
    }
    if (opts.decision !== '') {
      const ctx = needTaskCtx()
      if (opts.approvalKey === '' || opts.grantId === '' || opts.fingerprint === '') {
        console.error('task.mjs: 决定需要 --grant <grantId> 和 --fingerprint <fp>（都来自 --approvals / --approval-show 的输出；参数副本不被接受，服务端按不可变快照核对指纹）')
        finish(2)
      }
      const res = await request('POST', GATEWAY + '/api/dsh-bridge/approvals/' + encodeURIComponent(opts.approvalKey) + '/decide', {
        ...ctx,
        grantId: opts.grantId,
        fingerprint: opts.fingerprint,
        decision: opts.decision,
        ...(opts.idem !== '' ? { idempotencyKey: opts.idem } : {}),
      }, headers)
      const body = res.json
      console.log(JSON.stringify(body, null, 2))
      if (body !== null && typeof body === 'object' && body.ok === true) {
        console.error(opts.decision === 'reject'
          ? '已提交 reject（phase=' + body.phase + '，state=' + body.state + '）。官方终态是 rejected：再查一次看到 state=rejected 即收敛，不必等只对批准有意义的 confirmed。'
          : '已提交（phase=' + body.phase + '，state=' + body.state + '）。submitted ≠ confirmed：再查一次看 state=confirmed（官方 approval/decided=allowed-once 已观测）；decision-unknown 表示确认丢失，不要重发放行。')
        finish(0)
      }
      console.error('task.mjs: 决定被拒绝（reason=' + ((body && body.reason) || ('HTTP ' + res.status)) + '）——零放行。')
      finish(1)
    }
    // 清单 / 详情：认证 + 顺带续租；--wait-approval 提供 ≤30s 的有界等待；--renew 显式续期
    const ctx = needTaskCtx()
    const qs = ['originThreadId=' + encodeURIComponent(ctx.originThreadId), 'taskId=' + encodeURIComponent(ctx.taskId)]
    if (opts.grantId !== '') qs.push('grantId=' + encodeURIComponent(opts.grantId))
    if (opts.renewNow) {
      qs.push('renew=1')
      if (opts.extendSec > 0) qs.push('extendSec=' + encodeURIComponent(String(Math.min(opts.extendSec, 3600))))
    }
    const deadline = Date.now() + (opts.approvalWait > 0 ? opts.approvalWait * 1000 : 0)
    let payload
    for (;;) {
      const url = opts.approvalShow !== ''
        ? GATEWAY + '/api/dsh-bridge/approvals/' + encodeURIComponent(opts.approvalShow) + '?' + qs.join('&')
        : GATEWAY + '/api/dsh-bridge/approvals?' + qs.join('&')
      const res = await request('GET', url, undefined, headers)
      payload = res.json
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        if (opts.approvalShow !== '' || (Array.isArray(payload.approvals) && payload.approvals.length > 0)) break
      }
      if (Date.now() >= deadline || (payload !== null && typeof payload === 'object' && payload.ok === false)) break
      await sleep(500)
    }
    console.log(JSON.stringify(payload, null, 2))
    const pendingCount = payload !== null && typeof payload === 'object' && Array.isArray(payload.approvals)
      ? payload.approvals.filter((p) => p.state === 'pending').length : 0
    finish(payload !== null && typeof payload === 'object' && payload.ok === true ? (pendingCount > 0 ? 9 : 0) : 1)
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
    if (res.status !== 200) finish(6)
    // --status-wait：审批决定之后用它继续等终态（needs-approval 及时返回 9，不阻塞等 done）
    // 与初次 --in 默认等待**共用同一条有界等待路径**（第四轮修正：来源回显 + 自适应续租只写一次）。
    if (opts.statusWait === true && body !== null && typeof body === 'object'
      && (body.status === 'running' || body.status === 'accepted' || body.status === 'needs-approval')) {
      const waited = await awaitTerminal({
        taskId: opts.status,
        origin,
        grantId: typeof body.grantId === 'string' ? body.grantId : opts.grantId,
        grantLeaseUntil: body.grantLeaseUntil,
        timeoutSec: opts.timeoutSec,
        waitHeaders: controlHeaderValue(),
      })
      if (waited.reason === 'timeout') {
        console.error('等待超时(' + opts.timeoutSec + 's)，任务仍在后台。可用 --status <taskId> 继续查询。')
        finish(3)
      }
      const st = waited.status
      if (waited.reason === 'needs-approval') {
        console.log(JSON.stringify({ phase: 'needs-approval', ...st }))
        console.error('任务仍在等一次单次审批。用 --approvals --origin <id> --task <taskId> 查看并 --approve/--reject 决定后，再来 --status-wait 收结果；不要重发任务。')
        finish(9)
      }
      // 回执（第四轮首次验收修正 C）：只报**回执自身**的终态，绝不等父任务结果、绝不返回 waiting。
      if (waited.reason === 'receipt-terminal' || waited.reason === 'receipt-pending') receiptOutcome(st, waited.reason, origin)
      console.log(JSON.stringify({ phase: 'finished', ...st }))
      if (st.status === 'done') {
        console.log('=== DeepSeek 汇报 ===')
        console.log(st.result || '(无内容)')
      }
      finish(st.status === 'done' ? 0 : 1)
    }
    finish(0)
  }
  // 只读模型目录（M2）：不派活、不投递；旧网关没有 capabilities.modelRouting → 明确拒绝（零副作用）。
  if (opts.models) {
    let cap
    try { cap = await request('GET', GATEWAY + '/api/dsh-bridge/status') } catch (e) { cap = { json: null } }
    const routing = cap.json !== null && typeof cap.json === 'object' && cap.json.capabilities !== null && typeof cap.json.capabilities === 'object' ? cap.json.capabilities.modelRouting : undefined
    if (routing === undefined || routing === null || routing.supported !== true) {
      console.error('task.mjs: 网关未声明 capabilities.modelRouting（旧网关/插件未装载）——模型目录查询拒绝，未做任何派活。')
      finish(2)
    }
    const res = await request('GET', GATEWAY + '/api/dsh-bridge/models')
    if (res.json === null || typeof res.json !== 'object') {
      console.error('task.mjs: 网关返回 ' + res.status + '，模型目录响应不是 JSON（插件可能是旧版本）')
      console.error(String(res.text || '').slice(0, 200))
      finish(1)
    }
    console.log(JSON.stringify(res.json, null, 2))
    if (res.json.ok === false) {
      console.error('task.mjs: 目录查询未能完成（见上方 failures）。')
      finish(1)
    }
    finish(0)
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
    console.error('审批: node task.mjs --approval-key-init | --approval-key-rotate     # 离线初始化/轮换控制凭据（仓库外私有目录，raw key 不回显）')
    console.error('      node task.mjs --in "…" --session <id> --origin <id> --delegate [--delegate-ttl 秒] [--delegate-lease 秒] [--authorization "范围说明"]')
    console.error('      node task.mjs --approvals --origin <id> --task <taskId> [--grant <grantId>] [--wait-approval 秒] [--renew [--extend 秒]]   # 退出码 9=pending')
    console.error('      node task.mjs --approval-show <approvalKey> --origin <id> --task <taskId>   # 单条详情（不可变快照/指纹/期限）')
    console.error('      node task.mjs --approve <key> --origin <id> --task <taskId> --grant <grantId> --fingerprint <fp>   # 单次放行（--reject 同形）')
    console.error('      node task.mjs --revoke-grant <grantId> --origin <id> --task <taskId> | --renew-grant <grantId> --origin <id> --task <taskId> [--extend 秒]')
    console.error('      node task.mjs --status <taskId> --origin <id> [--grant <grantId>] --status-wait   # 审批后继续等终态（等待期间认证续租）')
    console.error('退出码: 0 成功 / 1 失败 / 2 用法（含缺少来源/缺控制凭据/预检拒绝） / 3 超时 / 4 会话未命中或不唯一 / 5 session 目标取消被拒 / 6 查询不到该任务（未知或来源不匹配） / 9 等待审批中（非终态）')
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
  // 委托派活**客户端预检**（新客户端 vs 旧网关 / 缺 key / 不支持目标 / 缺来源）→ 任何一项不过零执行。
  // 预检通过后，派活 POST 必须带**控制凭据头**（第四轮修正：之前漏传 request 第四参数 → 401 approval-control-invalid）。
  let dispatchHeaders = null
  if (opts.delegate === true || opts.steer === true || opts.parent !== '') dispatchHeaders = controlHeaderValue()
  if (opts.delegate === true) {
    if (origin.originThreadId === undefined) {
      console.error('task.mjs: --delegate 需要来源对话 id（grant 必须绑定 task+origin；请显式 --origin <id>）。未发出任何指令。')
      finish(2)
    }
    if (sessionTarget === null) {
      console.error('task.mjs: --delegate 只支持会话目标（worker 子代理身份未证实，委托不支持）。worker 请去掉 --delegate 用旧路径。未发出任何指令。')
      finish(2)
    }
    if (dispatchHeaders === null) {
      console.error('task.mjs: 本机没有控制凭据，审批委托默认关闭。先运行: node task.mjs --approval-key-init。未发出任何指令。')
      finish(2)
    }
    try {
      const cap = await request('GET', GATEWAY + '/api/dsh-bridge/status')
      const approvals = cap.json !== null && typeof cap.json === 'object' && cap.json.capabilities !== null && typeof cap.json.capabilities === 'object' ? cap.json.capabilities.approvals : undefined
      if (approvals === undefined || approvals === null || approvals.supported !== true) {
        console.error('task.mjs: 网关未声明 capabilities.approvals（旧网关/插件未装载）——委托派活预检拒绝，未发出任何指令。')
        finish(2)
      }
      if (approvals.enabled !== true) {
        console.error('task.mjs: 网关报告审批能力未启用（host 侧没有控制 key）——未发出任何指令。')
        finish(2)
      }
    } catch (e) {
      console.error('task.mjs: 审批能力预检失败（' + (e && e.message ? e.message : e) + '）——未发出任何指令。')
      finish(2)
    }
  }
  // 投递控制（第四轮）：steer 会改动既有任务 → 必须显式父任务 + 认证头；旧网关无 delivery 能力则零派活。
  const isSteer = opts.steer === true || opts.parent !== ''
  if (isSteer) {
    if (opts.parent === '') {
      console.error('task.mjs: --steer 必须显式给 --parent <taskId>（被补充的父任务；绝不按"最近/最老任务"推断）。未发出任何指令。')
      finish(2)
    }
    if (origin.originThreadId === undefined) {
      console.error('task.mjs: --steer 需要来源对话 id（请显式 --origin <id>），否则会改动可能是别人的在途任务。未发出任何指令。')
      finish(2)
    }
    if (dispatchHeaders === null) {
      console.error('task.mjs: --steer 需要本机控制凭据（它改动既有任务）。先运行: node task.mjs --approval-key-init。未发出任何指令。')
      finish(2)
    }
    try {
      const cap = await request('GET', GATEWAY + '/api/dsh-bridge/status')
      const delivery = cap.json !== null && typeof cap.json === 'object' && cap.json.capabilities !== null && typeof cap.json.capabilities === 'object' ? cap.json.capabilities.delivery : undefined
      if (delivery === undefined || delivery === null || delivery.supported !== true) {
        console.error('task.mjs: 网关未声明 capabilities.delivery（旧网关/插件未装载）——steer 预检拒绝，未发出任何指令。')
        finish(2)
      }
    } catch (e) {
      console.error('task.mjs: 投递能力预检失败（' + (e && e.message ? e.message : e) + '）——未发出任何指令。')
      finish(2)
    }
  }
  // 模型路由（M2）：新语义（--provider/--model-fallback/auto|default|精确 id）先只读预检能力，旧网关零派活。
  const usesModelRouting = opts.provider !== '' || opts.modelFallback !== undefined
    || (opts.model !== '' && opts.model !== 'fast' && opts.model !== 'pro')
  if (usesModelRouting) {
    let cap
    try { cap = await request('GET', GATEWAY + '/api/dsh-bridge/status') } catch (e) { cap = { json: null } }
    const routing = cap.json !== null && typeof cap.json === 'object' && cap.json.capabilities !== null && typeof cap.json.capabilities === 'object' ? cap.json.capabilities.modelRouting : undefined
    if (routing === undefined || routing === null || routing.supported !== true) {
      console.error('task.mjs: 网关未声明 capabilities.modelRouting（旧网关/插件未装载）——模型路由参数预检拒绝，未发出任何指令。')
      finish(2)
    }
  }
  const posted = await request('POST', GATEWAY + '/api/dsh-bridge/task', {
    instruction,
    ...(origin.originThreadId === undefined ? {} : { originThreadId: origin.originThreadId }),
    // 模型控制字段是 **worker 与 session 共用** 的任务级策略：provider+model 是一对身份，
    // 绝不能只在 worker 分支发送（否则 --session S --provider P --model M 会丢掉精确 pair 退化成 auto）。
    ...(opts.provider !== '' ? { provider: opts.provider } : {}),
    ...(opts.model !== '' ? { model: opts.model } : {}),
    ...(opts.modelFallback === undefined ? {} : { modelFallback: opts.modelFallback }),
    ...(isSteer ? { parentTaskId: opts.parent, ...(opts.expectedTurn > 0 ? { expectedTurn: opts.expectedTurn } : {}) } : {}),
    ...(opts.delegate === true
      ? {
          delegate: true,
          ...(opts.delegateTtl > 0 ? { delegateTtlSec: opts.delegateTtl } : {}),
          ...(opts.delegateLease > 0 ? { delegateLeaseSec: opts.delegateLease } : {}),
          ...(opts.authorization !== '' ? { authorization: opts.authorization } : {}),
        }
      : {}),
    ...(sessionTarget === null
      ? {
          ...{ history },
          ...(cwd ? { cwd } : {}),
          ...(opts.lane ? { lane: opts.lane } : {}),
        }
      : {
          ...sessionTarget,
          ...(isSteer ? { deliver: 'steer' } : {}),
        }),
  }, dispatchHeaders)
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
  if (!opts.wait) {
    if (isSteer) {
      console.log(JSON.stringify({ phase: 'receipt-accepted', ...task }))
      console.error('补充回执已接收（resultScope=parent-task）。它不代表父任务结果；父任务最终结果请查: node task.mjs --status ' + (task.parentTaskId || opts.parent) + (origin.originThreadId === undefined ? '' : ' --origin ' + origin.originThreadId) + ' --status-wait')
    }
    finish(0)
  }
  // steer 回执：**不等父任务结果**（父任务唯一拥有最终结果）。只报告自身接收/观察状态。
  if (isSteer) {
    console.log(JSON.stringify({ phase: task.receiptState === 'observed' ? 'receipt-observed' : (task.receiptState === 'unconfirmed' ? 'receipt-unconfirmed' : 'receipt-accepted'), ...task }))
    console.error('这是**补充回执**（resultScope=parent-task，receiptState=' + (task.receiptState || 'accepted') + (task.observedTurn === undefined ? '' : '，observedTurn=' + task.observedTurn) + '）：')
    console.error('  * 它不证明父任务已完成，也不是独立答案；')
    console.error('  * 父任务最终结果: node task.mjs --status ' + (task.parentTaskId || opts.parent) + (origin.originThreadId === undefined ? '' : ' --origin ' + origin.originThreadId) + ' --status-wait')
    console.error('  * 若为 receipt-unconfirmed：官方已接收但没在窗口内观察到落进父回合——**不要重发**。')
    finish(0)
  }

  // 初次等待与 --status-wait 共用同一条有界等待路径（第四轮修正）：
  //   带 origin 的 status + 逐次回显核对 + 按响应 grant 字段自适应认证续租 + needs-approval 及时退出 9。
  const waited = await awaitTerminal({
    taskId: task.taskId,
    origin,
    grantId: task.grantId,
    grantLeaseUntil: task.grantLeaseUntil,
    timeoutSec: opts.timeoutSec,
    waitHeaders: controlHeaderValue(),
  })
  if (waited.reason === 'timeout') {
    console.error('等待超时(' + opts.timeoutSec + 's)，任务仍在后台执行。可用 status 接口继续查询:')
    console.error(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(task.taskId) + (origin.originThreadId === undefined ? '' : '&originThreadId=' + encodeURIComponent(origin.originThreadId)))
    finish(3)
  }
  if (waited.reason === 'receipt-terminal' || waited.reason === 'receipt-pending') receiptOutcome(waited.status, waited.reason, origin)
  const status = waited.status
  const taskCtx = origin.originThreadId === undefined ? '' : ' --origin ' + origin.originThreadId + ' --task ' + task.taskId
  if (waited.reason === 'needs-approval') {
    // needs-approval：非终态、不是失败——**及时返回**让调用方决策（退出码 9），绝不阻塞等 done。
    console.log(JSON.stringify({ phase: 'needs-approval', ...status }))
    console.error('任务正等待一次单次审批（非终态，不是失败）。下一步:')
    console.error('  node task.mjs --approvals' + taskCtx + (typeof task.grantId === 'string' ? ' --grant ' + task.grantId : '') + '   # 取真实待审动作（含参数/指纹/期限）')
    console.error('  node task.mjs --approve <approvalKey>' + taskCtx + ' --grant <grantId> --fingerprint <fp>   # 单次放行')
    console.error('  node task.mjs --reject <approvalKey>' + taskCtx + ' --grant <grantId> --fingerprint <fp>')
    console.error('然后: node task.mjs --status ' + task.taskId + (origin.originThreadId === undefined ? '' : ' --origin ' + origin.originThreadId) + ' --status-wait 继续收取结果。不要重发任务。')
    finish(9)
  }
  {
    console.log(JSON.stringify({ phase: 'finished', ...status }))
    console.log('=== DeepSeek 汇报 ===')
    console.log(status.result || status.error || '(无内容)')
    // delivered=true 表示 prompt 已被那条会话接受（进了它的队列）：即便我们等超时了，
    // 消息也可能会跑，**不要重发**（重发会让同一份内容在用户会话里出现两次）。
    if (status.status === 'error' && status.delivered === true) {
      console.error('注意: 消息已投递进该会话的队列（delivered=true），只是我们没等到它开跑。不要重发；可用 --status ' + task.taskId + ' 继续观察。')
    }
    if (status.status === 'unknown') {
      console.error('执行/交付状态未确认（可能仍在后台，或已不可考）。**不要重发**；可用 --status ' + task.taskId + ' 复核。')
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

// 退出收尾：先静默 stderr（抑制 Node 退出时的 libuv 断言噪音），再按码退出。
// 任务结果以 stdout 中 "=== DeepSeek 汇报 ===" 为准。
function finish(code) {
  try { process.stderr.write = () => true } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch((e) => { console.error('task.mjs 失败:', (e && e.message) || e); finish(1) })
