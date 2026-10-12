#!/usr/bin/env node
// dsh-mcp: Codex / ChatGPT MCP 服务器，把 DeepSeek Harness 协作网关暴露为 MCP 工具。
// 两种传输：
//   stdio（默认）：每行一个 JSON-RPC 2.0 消息，供 Codex 等本地 MCP 客户端使用。
//   --http [host:port]：Streamable HTTP（POST /mcp，JSON 请求/响应），供隧道
//      客户端（Secure MCP Tunnel / cloudflared）桥接给 ChatGPT 等远程产品。
const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'
const SERVER_NAME = 'dsh-bridge'
const SERVER_VERSION = '0.1.8'
const PROTOCOL_VERSION = '2024-11-05'

const log = (...args) => console.error('[dsh-mcp]', ...args)

const tools = [
  {
    name: 'dsh_task',
    description:
      '把编码任务交给本机 DeepSeek Harness 执行（DeepSeek 写代码，ChatGPT/Codex 验收）。两种目标：默认新建编码子代理在 cwd 里干活；' +
      '给出 sessionId 或 sessionQuery 时改为**投递进那一条已有会话**（保留它自己的上下文，不新建会话/工作区）。' +
      '参数: instruction(必填,完整中文指令:目标/产出目录/验收标准/约束), cwd(工作目录,默认 D:\\Harness,通常传当前项目目录), ' +
      'lane(并行通道名,默认 main), model(fast=deepseek-v4-flash 快而省 / pro=deepseek-v4-pro 质量优先), ' +
      'sessionId(已有会话 id), sessionQuery(按标题/内容搜已有会话,需唯一命中,否则返回候选), deliver(queue=排队(默认) / steer=插入当前回合), ' +
      'dryRun(true 时只解析目标并回显, 不投递任何消息), ' +
      'originThreadId(发起本任务的 Codex 对话 id,必须显式传入), ' +
      'wait(默认 true,阻塞至任务完成并返回 DeepSeek 汇报), timeoutSec(默认 600,最长 900)。' +
      '每个回合派活都要显式传 originThreadId=当前对话 id（传入本工具调用的那个对话）：它把任务与发起对话持久绑定，' +
      '之后任何回合都能用 originThreadId+taskId 精确取回这次任务的结果。**不要**用常驻进程环境变量或"最近对话"推断来源。' +
      '注意: 验证"这条查询会命中哪条会话"必须用 dryRun 或 dsh_sessions——**绝不要投递一条消息去试探**（那会污染用户会话）。',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '完整中文编码指令（目标、产出目录、验收标准、约束）。dryRun 时可省略。' },
        cwd: { type: 'string', description: '工作目录（绝对路径）。默认 D:\\Harness。与 sessionId/sessionQuery 互斥。' },
        lane: { type: 'string', description: '并行通道名（默认 main）。' },
        model: { type: 'string', enum: ['fast', 'pro'], description: '模型别名：fast=deepseek-v4-flash，pro=deepseek-v4-pro。' },
        sessionId: { type: 'string', description: '已有会话 id：把指令投递进这条会话，而不是新建子代理。' },
        sessionQuery: { type: 'string', description: '按标题或内容搜索已有会话；唯一命中才派发，多条或落空会返回 candidates 让你改用 sessionId。' },
        deliver: { type: 'string', enum: ['queue', 'steer'], description: '投递方式：queue 排队（默认），steer 插入当前回合。' },
        dryRun: { type: 'boolean', description: '只解析目标并回显（含命中路径 matchedBy 与候选），不投递任何消息。用来确认命中，替代"发消息探测"。' },
        originThreadId: { type: 'string', description: '发起本任务的 Codex 对话 id（来源关联，显式传入）。用于之后按 originThreadId+taskId 精确收取结果。' },
        wait: { type: 'boolean', description: '默认 true：阻塞直到任务完成并返回汇报。' },
        timeoutSec: { type: 'number', description: '最长等待秒数（默认 600，最大 900）。' },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'dsh_sessions',
    description:
      '只读查找本机 DSH 的已有会话（不创建、不投递）。用 sessionQuery 按标题/内容搜，或用 sessionId 直接解析某一条；' +
      '拿到 sessionId 后交给 dsh_task 即可把任务投递进那条会话。参数: query, sessionId, limit(默认 10), inspect(默认 false,为 true 时探测前 5 条能否接)。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按标题/内容搜索（与 sessionId 二选一）。' },
        sessionId: { type: 'string', description: '直接解析某条会话（与 query 二选一）。' },
        limit: { type: 'number', description: '最多返回条数（默认 10，最大 50）。' },
        inspect: { type: 'boolean', description: '为 true 时对前 5 条探测 agentAvailable / problem（默认 false）。' },
      },
    },
  },
  {
    name: 'dsh_task_status',
    description:
      '查询 DeepSeek 协作任务的状态与结果。两种用法：' +
      '(1) taskId + originThreadId → 精确取这次任务的状态/结果（跨回合、网关重载后都能按来源从持久关联记录恢复；' +
      '恢复到的未完成任务会返回 status=unknown 并明确"执行/交付状态未能确认、请勿重发"）；' +
      '(2) 只给 originThreadId → 列出该对话登记过的任务，用来找回丢失的 taskId。' +
      'originThreadId 必须显式传当前对话 id；只给 taskId 时保持旧的兼容查询。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID（dsh_task 返回）。与 originThreadId 一起用时为精确取值。' },
        originThreadId: { type: 'string', description: '发起该任务的 Codex 对话 id（显式传入当前对话）。只给来源时列出该对话的任务。' },
      },
    },
  },
  {
    name: 'dsh_task_cancel',
    description: '取消一个运行中的 DeepSeek 协作任务。参数: taskId(必填), force(session 目标的任务默认拒绝取消,因为它会打断用户自己的回合;确认要打断时传 true), originThreadId(可选,已关联任务必须传同一个来源)。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID。' },
        force: { type: 'boolean', description: '仅对投递进已有会话的任务有意义：true 才真正打断该会话。' },
        originThreadId: { type: 'string', description: '该任务的来源对话 id（已关联任务必须一致，避免别的对话取消它）。' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'dsh_review',
    description:
      '让独立评审子代理审查某工作目录的代码变更。评审员会读磁盘真实文件、静态审查，并实际运行构建/测试验证可跑通，返回结构化评审报告。' +
      '参数: cwd(必填), diff(变更 diff 文本), focus(审查重点), originThreadId(发起本次评审的当前对话 id,显式传入;评审同样产生 taskId,因此同样支持按 origin+taskId 收取), wait(默认 true), timeoutSec(默认 900)。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '评审目标所在工作目录（绝对路径）。' },
        diff: { type: 'string', description: '变更 diff 文本（git diff 输出）。省略时评审员自行读取目录现状。' },
        focus: { type: 'string', description: '审查重点。' },
        originThreadId: { type: 'string', description: '发起本次评审的 Codex 对话 id（来源关联，显式传入当前对话）。' },
        wait: { type: 'boolean', description: '默认 true：阻塞直到评审完成。' },
        timeoutSec: { type: 'number', description: '最长等待秒数（默认 900）。' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'dsh_read_file',
    description:
      '读取共享工作目录中的文件内容（用于验收 DeepSeek 的产出，无需本地文件权限）。' +
      '参数: path(必填,绝对路径或相对 cwd 的路径), maxBytes(默认 100000)。仅限 UTF-8 文本文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读的文件路径（绝对路径，或相对 D:\\Harness 的路径）。' },
        maxBytes: { type: 'number', description: '最大读取字节数（默认 100000）。' },
      },
      required: ['path'],
    },
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_ORIGIN_LENGTH = 200

/** 显式来源必须合法：非空字符串、≤200 字符、无控制字符。**不合法就拒绝，绝不丢掉或改用环境变量。** */
const isValidOrigin = (value) => typeof value === 'string'
  && value.trim() !== ''
  && value.trim().length <= MAX_ORIGIN_LENGTH
  && !/[\u0000-\u001f\u007f]/.test(value)

/**
 * 只读核验网关是否真的支持"持久来源绑定"。
 * **不能靠包版本猜**：旧网关会忽略 originThreadId 并照常 accepted，从而产生未绑定任务。
 * 这里要求网关在 /status（无参数）里明确上报 `capabilities.originBinding.supported === true`；
 * 拿不到（旧网关 / 关联存储不可用）一律视为不支持。
 */
async function originBindingSupported() {
  try {
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status')
    const body = await res.json()
    return body !== null && typeof body === 'object'
      && body.capabilities !== null && typeof body.capabilities === 'object'
      && body.capabilities.originBinding !== null && typeof body.capabilities.originBinding === 'object'
      && body.capabilities.originBinding.supported === true
  } catch (e) {
    return false
  }
}

const ORIGIN_UNSUPPORTED = {
  ok: false,
  reason: 'origin-binding-unsupported',
  error: 'this gateway does not support persistent origin binding (it does not advertise capabilities.originBinding); refusing to dispatch an unbound task. Upgrade the dsh-codex-collab plugin in the DSH profile, or dispatch without originThreadId.',
}

const INVALID_ORIGIN = {
  ok: false,
  reason: 'invalid-origin',
  error: 'originThreadId must be a non-empty string (<= 200 characters, no control characters); omit it entirely for the legacy unbound mode',
}

/** 网关自己给出的"明确拒绝"reason：原样透传（这些不是"成功了但没确认"）。 */
const REFUSAL_REASONS = new Set([
  'origin-required',
  'origin-mismatch',
  'invalid-origin',
  'unknown-task',
  'execution-state-unconfirmed',
])

/** 网关必须**回显并匹配**我们请求的 originThreadId，才算确认了这次绑定/取值。 */
const originConfirmed = (payload, originThreadId) => payload !== null && typeof payload === 'object' && payload.originThreadId === originThreadId

/**
 * 能力检查通过 ≠ 这次绑定被确认：网关可能在中途换了处理者（重载/旧 handler），接受了请求却没写关联。
 * 此时任务**可能已经执行**，所以既不能说成功，也绝不能重发；只如实上报未确认。
 * 注意：只挑 taskId/status，**绝不**把网关响应里的 result 透出去。
 */
const unconfirmedPayload = (payload) => ({
  ok: false,
  phase: 'unconfirmed',
  // 网关自称的 status 不可信（它可能压根没绑定）：一律按"未确认"上报。
  status: 'unknown',
  reason: 'origin-not-confirmed',
  resend: false,
  error: 'the gateway accepted the request but did not confirm the source binding (no matching originThreadId in its response); it may have executed unbound — do not resend',
  ...(payload !== null && typeof payload === 'object' && typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
})

/** 解析显式来源：undefined=未传（旧模式）；否则必须合法，不合法直接拒绝（不回落、不改用 ENV）。 */
function readOrigin(args) {
  if (args === null || typeof args !== 'object') return { ok: true, originThreadId: undefined }
  if (!Object.prototype.hasOwnProperty.call(args, 'originThreadId')) return { ok: true, originThreadId: undefined }
  const raw = args.originThreadId
  if (raw === undefined) return { ok: true, originThreadId: undefined }
  if (!isValidOrigin(raw)) return { ok: false, value: INVALID_ORIGIN }
  return { ok: true, originThreadId: raw.trim() }
}

async function callGateway(method, body) {
  const res = await fetch(GATEWAY + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return res.json()
}

async function waitTask(taskId, timeoutSec, originThreadId) {
  const deadline = Date.now() + Math.min(Math.max(timeoutSec || 600, 5), 900) * 1000
  const suffix = typeof originThreadId === 'string' && originThreadId !== '' ? '&originThreadId=' + encodeURIComponent(originThreadId) : ''
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + suffix)
    const status = await res.json()
    // unknown：恢复到的任务执行/交付状态未能确认——**必须停止轮询**，不能无限等。终态同理。
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled' || status.status === 'unknown') return status
  }
  return { taskId, status: 'waiting', note: '仍在后台执行，可用 dsh_task_status 查询', ...(suffix === '' ? {} : { originThreadId }) }
}

async function handleToolCall(name, args) {
  if (name === 'dsh_task') {
    const origin = readOrigin(args)
    if (!origin.ok) return origin.value
    // 显式来源：先只读核验网关能力（GET，不会派活），不支持就**零执行**拒绝。
    if (origin.originThreadId !== undefined && !(await originBindingSupported())) return ORIGIN_UNSUPPORTED
    const task = await callGateway('/api/dsh-bridge/task', {
      instruction: args.instruction,
      cwd: args.cwd,
      lane: args.lane,
      model: args.model,
      sessionId: args.sessionId,
      sessionQuery: args.sessionQuery,
      deliver: args.deliver,
      dryRun: args.dryRun === true,
      originThreadId: origin.originThreadId,
    })
    // dryRun 只解析目标，不产生任务：原样回显给你看命中结果。
    if (args.dryRun === true) return { ok: task.resolved === true, phase: 'dry-run', ...task }
    // 4xx 拒绝（缺目标 / 会话不存在 / 搜索结果不唯一 / 通道忙 / 非法来源）不带 taskId，绝不静默新建。
    if (task.taskId === undefined) return { ok: false, phase: 'rejected', ...task }
    // 能力检查通过 ≠ 这次绑定被确认：网关必须回显匹配的 originThreadId。没有 → 未确认、不要重发。
    if (origin.originThreadId !== undefined && !originConfirmed(task, origin.originThreadId)) return unconfirmedPayload(task)
    if (task.status === 'error') return { ok: false, ...task }
    if (args.wait === false) return { ok: true, phase: 'submitted', ...task }
    const done = await waitTask(task.taskId, args.timeoutSec || 600, origin.originThreadId)
    // 会话目标报错但 delivered=true：消息已在目标会话队列里，不要重发。
    if (done.delivered === true && done.status === 'error') {
      return { ok: false, phase: 'queued-then-failed', resend: false, ...done }
    }
    // 恢复到的任务：执行/交付状态未知——如实上报并明确"不要重发"。
    if (done.status === 'unknown') {
      return { ok: false, phase: 'unconfirmed', resend: false, ...done }
    }
    return { ok: done.status === 'done', phase: 'finished', ...done }
  }
  if (name === 'dsh_sessions') {
    if (args.query === undefined && args.sessionId === undefined) {
      return { ok: false, error: 'query or sessionId is required' }
    }
    const found = await callGateway('/api/dsh-bridge/sessions', {
      query: args.query,
      sessionId: args.sessionId,
      limit: args.limit,
      inspect: args.inspect,
    })
    if (Array.isArray(found.items)) return { ok: true, ...found }
    return { ok: false, ...found }
  }
  if (name === 'dsh_task_status') {
    // 两种用法：
    //   taskId [+ originThreadId] → 精确取值（跨回合/网关重载后也能按 origin 从持久记录恢复）
    //   只给 originThreadId       → 列出该对话登记过的任务，用来找回丢失的 taskId
    const origin = readOrigin(args)
    if (!origin.ok) return origin.value
    // 显式来源=精确恢复语义：网关不支持时必须明确失败，绝不能把旧网关的普通响应当成精确恢复。
    if (origin.originThreadId !== undefined && !(await originBindingSupported())) return ORIGIN_UNSUPPORTED
    const params = []
    if (typeof args.taskId === 'string' && args.taskId !== '') params.push('taskId=' + encodeURIComponent(args.taskId))
    if (origin.originThreadId !== undefined) params.push('originThreadId=' + encodeURIComponent(origin.originThreadId))
    if (params.length === 0) return { ok: false, error: 'taskId or originThreadId is required' }
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status?' + params.join('&'))
    const payload = await res.json()
    // 精确取值必须由网关**确认来源**：没有匹配的 originThreadId 就不算精确恢复（也绝不透出 result）。
    if (origin.originThreadId !== undefined
      && !(payload !== null && typeof payload === 'object' && typeof payload.reason === 'string' && REFUSAL_REASONS.has(payload.reason))
      && !originConfirmed(payload, origin.originThreadId)) {
      return unconfirmedPayload(payload)
    }
    return payload
  }
  if (name === 'dsh_task_cancel') {
    const origin = readOrigin(args)
    if (!origin.ok) return origin.value
    if (origin.originThreadId !== undefined && !(await originBindingSupported())) return ORIGIN_UNSUPPORTED
    const payload = await callGateway('/api/dsh-bridge/cancel', { taskId: args.taskId, force: args.force === true, ...(origin.originThreadId === undefined ? {} : { originThreadId: origin.originThreadId }) })
    if (origin.originThreadId !== undefined && payload !== null && typeof payload === 'object' && payload.cancelled === true && !originConfirmed(payload, origin.originThreadId)) return unconfirmedPayload(payload)
    return payload
  }
  if (name === 'dsh_review') {
    const origin = readOrigin(args)
    if (!origin.ok) return origin.value
    if (origin.originThreadId !== undefined && !(await originBindingSupported())) return ORIGIN_UNSUPPORTED
    const task = await callGateway('/api/dsh-bridge/review', { cwd: args.cwd, diff: args.diff, focus: args.focus, originThreadId: origin.originThreadId })
    if (origin.originThreadId !== undefined && task.taskId !== undefined && !originConfirmed(task, origin.originThreadId)) return unconfirmedPayload(task)
    if (task.status === 'error') return { ok: false, ...task }
    if (args.wait === false) return { ok: true, phase: 'submitted', ...task }
    const done = await waitTask(task.taskId, args.timeoutSec || 900, origin.originThreadId)
    if (done.status === 'unknown') return { ok: false, phase: 'unconfirmed', resend: false, ...done }
    return { ok: done.status === 'done', phase: 'finished', ...done }
  }
  if (name === 'dsh_read_file') {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const DEFAULT_ROOT = process.env.DSH_BRIDGE_ROOT || 'D:\\Harness'
    const raw = String(args.path || '')
    let full = raw
    if (!path.isAbsolute(raw)) full = path.join(DEFAULT_ROOT, raw)
    const maxBytes = Math.min(Math.max(Number(args.maxBytes) || 100000, 1), 1000000)
    const buf = fs.readFileSync(full)
    if (buf.length > maxBytes) {
      return { ok: false, error: 'file too large (' + buf.length + ' bytes, max ' + maxBytes + ')' }
    }
    return { ok: true, path: full, bytes: buf.length, content: buf.toString('utf8') }
  }
  throw new Error('unknown tool: ' + name)
}

// ---- JSON-RPC 核心（两种传输共用）----
async function handleMessage(msg) {
  const id = msg.id
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } }
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null
  if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    try {
      const value = await handleToolCall(name, args)
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + (e && e.message || e) }], isError: true } }
    }
  }
  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + msg.method } }
  }
  return null
}

// ---- stdio 传输 ----
function runStdio() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') {
        let msg
        try { msg = JSON.parse(line) } catch (e) { idx = buffer.indexOf('\n'); continue }
        void handleMessage(msg).then((resp) => {
          if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n')
        })
      }
      idx = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    log('stdio closed')
    setTimeout(() => process.exit(0), 200)
  })
  log('stdio MCP ready, gateway=' + GATEWAY)
}

// ---- Streamable HTTP 传输 ----
async function runHttp(bindSpec) {
  const { createServer } = await import('node:http')
  const [host, portStr] = bindSpec.split(':')
  const port = Number(portStr) || 4800
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', server: SERVER_NAME }))
      return
    }
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      const chunks = []
      let size = 0
      req.on('data', (c) => { size += c.length; if (size <= 2 * 1024 * 1024) chunks.push(c) })
      req.on('end', () => {
        void (async () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(body)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            const results = []
            for (const msg of list) {
              const resp = await handleMessage(msg)
              if (resp !== null) results.push(resp)
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(Array.isArray(parsed) ? results : (results[0] || {})))
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: ' + (e && e.message || e) } }))
          }
        })()
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.listen(port, host, () => {
    log('HTTP MCP ready at http://' + host + ':' + port + '/mcp, gateway=' + GATEWAY)
  })
}

// ---- 入口 ----
const httpArg = process.argv.findIndex((a) => a === '--http')
if (httpArg !== -1) {
  const spec = process.argv[httpArg + 1] || '127.0.0.1:4800'
  runHttp(spec)
} else {
  runStdio()
}
