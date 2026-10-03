#!/usr/bin/env node
// dsh-mcp: Codex / ChatGPT MCP 服务器，把 DeepSeek Harness 协作网关暴露为 MCP 工具。
// 两种传输：
//   stdio（默认）：每行一个 JSON-RPC 2.0 消息，供 Codex 等本地 MCP 客户端使用。
//   --http [host:port]：Streamable HTTP（POST /mcp，JSON 请求/响应），供隧道
//      客户端（Secure MCP Tunnel / cloudflared）桥接给 ChatGPT 等远程产品。
const GATEWAY = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'
const SERVER_NAME = 'dsh-bridge'
const SERVER_VERSION = '0.1.1'
const PROTOCOL_VERSION = '2024-11-05'

const log = (...args) => console.error('[dsh-mcp]', ...args)

const tools = [
  {
    name: 'dsh_task',
    description:
      '把编码任务交给本机 DeepSeek Harness 的编码子代理执行（DeepSeek 写代码，ChatGPT/Codex 验收）。' +
      '参数: instruction(必填,完整中文指令:目标/产出目录/验收标准/约束), cwd(工作目录,默认 D:\\Harness,通常传当前项目目录), ' +
      'lane(并行通道名,默认 main), model(fast=deepseek-v4-flash 快而省 / pro=deepseek-v4-pro 质量优先), ' +
      'wait(默认 true,阻塞至任务完成并返回 DeepSeek 汇报), timeoutSec(默认 600,最长 900)。',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '完整中文编码指令（目标、产出目录、验收标准、约束）。' },
        cwd: { type: 'string', description: '工作目录（绝对路径）。默认 D:\\Harness。' },
        lane: { type: 'string', description: '并行通道名（默认 main）。' },
        model: { type: 'string', enum: ['fast', 'pro'], description: '模型别名：fast=deepseek-v4-flash，pro=deepseek-v4-pro。' },
        wait: { type: 'boolean', description: '默认 true：阻塞直到任务完成并返回汇报。' },
        timeoutSec: { type: 'number', description: '最长等待秒数（默认 600，最大 900）。' },
      },
      required: ['instruction'],
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
    description: '取消一个运行中的 DeepSeek 协作任务。参数: taskId(必填)。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 ID。' } },
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
    })
    if (task.status === 'error') return { ok: false, ...task }
    if (args.wait === false) return { ok: true, phase: 'submitted', ...task }
    const done = await waitTask(task.taskId, args.timeoutSec || 600)
    return { ok: done.status === 'done', phase: 'finished', ...done }
  }
  if (name === 'dsh_task_status') {
    const res = await fetch(GATEWAY + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(args.taskId))
    return res.json()
  }
  if (name === 'dsh_task_cancel') {
    return callGateway('/api/dsh-bridge/cancel', { taskId: args.taskId })
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
