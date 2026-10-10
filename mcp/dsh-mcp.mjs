#!/usr/bin/env node
// dsh-mcp: Codex / ChatGPT MCP 服务器，把 DeepSeek Harness 协作网关暴露为 MCP 工具。
// 两种传输：
//   stdio（默认）：每行一个 JSON-RPC 2.0 消息，供 Codex 等本地 MCP 客户端使用。
//   --http [host:port]：Streamable HTTP（POST /mcp，JSON 请求/响应），供隧道
//      客户端（Secure MCP Tunnel / cloudflared）桥接给 ChatGPT 等远程产品。
const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'
const SERVER_NAME = 'dsh-bridge'
const SERVER_VERSION = '0.1.7'
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
      'wait(默认 true,阻塞至任务完成并返回 DeepSeek 汇报), timeoutSec(默认 600,最长 900)。' +
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
    description: '查询 DeepSeek 协作任务的当前状态与结果。参数: taskId(必填)。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 ID（dsh_task 返回）。' } },
      required: ['taskId'],
    },
  },
  {
    name: 'dsh_task_cancel',
    description: '取消一个运行中的 DeepSeek 协作任务。参数: taskId(必填), force(session 目标的任务默认拒绝取消,因为它会打断用户自己的回合;确认要打断时传 true)。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID。' },
        force: { type: 'boolean', description: '仅对投递进已有会话的任务有意义：true 才真正打断该会话。' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'dsh_review',
    description:
      '让独立评审子代理审查某工作目录的代码变更。评审员会读磁盘真实文件、静态审查，并实际运行构建/测试验证可跑通，返回结构化评审报告。' +
      '参数: cwd(必填), diff(变更 diff 文本), focus(审查重点), wait(默认 true), timeoutSec(默认 900)。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '评审目标所在工作目录（绝对路径）。' },
        diff: { type: 'string', description: '变更 diff 文本（git diff 输出）。省略时评审员自行读取目录现状。' },
        focus: { type: 'string', description: '审查重点。' },
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

async function callGateway(method, body) {
  const res = await fetch(GATEWAY + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return res.json()
}

async function waitTask(taskId, timeoutSec) {
  const deadline = Date.now() + Math.min(Math.max(timeoutSec || 600, 5), 900) * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId))
    const status = await res.json()
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') return status
  }
  return { taskId, status: 'waiting', note: '仍在后台执行，可用 dsh_task_status 查询' }
}

async function handleToolCall(name, args) {
  if (name === 'dsh_task') {
    const task = await callGateway('/api/dsh-bridge/task', {
      instruction: args.instruction,
      cwd: args.cwd,
      lane: args.lane,
      model: args.model,
      sessionId: args.sessionId,
      sessionQuery: args.sessionQuery,
      deliver: args.deliver,
      dryRun: args.dryRun === true,
    })
    // dryRun 只解析目标，不产生任务：原样回显给你看命中结果。
    if (args.dryRun === true) return { ok: task.resolved === true, phase: 'dry-run', ...task }
    // 4xx 拒绝（缺目标 / 会话不存在 / 搜索结果不唯一 / 被写锁占用）不带 taskId，绝不静默新建。
    if (task.taskId === undefined) return { ok: false, phase: 'rejected', ...task }
    if (task.status === 'error') return { ok: false, ...task }
    if (args.wait === false) return { ok: true, phase: 'submitted', ...task }
    const done = await waitTask(task.taskId, args.timeoutSec || 600)
    // 会话目标报错但 delivered=true：消息已在目标会话队列里，不要重发。
    if (done.delivered === true && done.status === 'error') {
      return { ok: false, phase: 'queued-then-failed', resend: false, ...done }
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
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(args.taskId))
    return res.json()
  }
  if (name === 'dsh_task_cancel') {
    return callGateway('/api/dsh-bridge/cancel', { taskId: args.taskId, force: args.force === true })
  }
  if (name === 'dsh_review') {
    const task = await callGateway('/api/dsh-bridge/review', { cwd: args.cwd, diff: args.diff, focus: args.focus })
    if (task.status === 'error') return { ok: false, ...task }
    if (args.wait === false) return { ok: true, phase: 'submitted', ...task }
    const done = await waitTask(task.taskId, args.timeoutSec || 900)
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
