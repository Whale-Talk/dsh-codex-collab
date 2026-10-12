/**
 * R1 集成测试共享宿主（不是测试文件本身，CI 的 `test/*.test.mjs` 不会误跑它）。
 *
 * 提供：真实 http.Server + 真实 apply(ctx)（假 DSH 运行时）、独立 MCP 进程、独立 CLI 进程、
 * 临时目录管理，以及**失败路径也会收尾**的统一清理。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const repoRoot = path.resolve(import.meta.dirname, '..', '..')
export const tmpParent = path.resolve(os.tmpdir())
export const MCP_PATH = path.join(repoRoot, 'mcp', 'dsh-mcp.mjs')
export const CLI_PATH = path.join(repoRoot, 'codex-plugin', 'plugins', 'dsh', 'skills', 'dsh-collab', 'scripts', 'task.mjs')

const created = []
const gateways = []
const children = []

export const makeTmp = async (prefix) => {
  const dir = await mkdtemp(path.join(tmpParent, prefix))
  created.push(dir)
  return dir
}

/** 递归删除前必须校验绝对目标确实在临时根下且名字符合预期。 */
const safeRemove = async (dir) => {
  const resolved = path.resolve(dir)
  if (!resolved.startsWith(tmpParent + path.sep)) throw new Error('refusing to remove path outside temp: ' + resolved)
  if (!path.basename(resolved).startsWith('dsh-')) throw new Error('refusing to remove unexpected path: ' + resolved)
  await rm(resolved, { recursive: true, force: true })
}

/** 收尾：先杀子进程 → 关网关 → 删临时目录。失败的测试也不会留下监听句柄。 */
export const disposeAll = async () => {
  for (const child of children) { try { child.kill() } catch (e) { /* ignore */ } }
  children.length = 0
  for (const gateway of gateways) { try { await gateway.close() } catch (e) { /* ignore */ } }
  gateways.length = 0
  for (const dir of created.reverse()) await safeRemove(dir).catch(() => {})
  created.length = 0
}

let bridgePromise
const loadBridge = async () => {
  if (bridgePromise !== undefined) return bridgePromise
  bridgePromise = (async () => {
    const fixtureRoot = await makeTmp('dsh-r1-fixture-')
    await cp(path.join(repoRoot, 'harness'), path.join(fixtureRoot, 'harness'), { recursive: true })
    const stubRoot = path.join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    await mkdir(stubRoot, { recursive: true })
    await writeFile(path.join(stubRoot, 'package.json'), JSON.stringify({ type: 'module', main: './index.js', exports: './index.js' }), 'utf8')
    await writeFile(path.join(stubRoot, 'index.js'), 'export const defineTool = (tool) => tool\n', 'utf8')
    return import(pathToFileURL(path.join(fixtureRoot, 'harness', 'dsh-bridge.mjs')).href)
  })()
  return bridgePromise
}

export const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * fetch/undici 按规范**禁用**的端口（"bad port"）。
 * 测试网关若恰好被系统分配到这些端口，`fetch` 会直接拒绝连接（TypeError: fetch failed / bad port）——
 * 表现为"网关已 ready 但请求失败、且没有任何 bridge 日志"的诡异失败。这里主动避开。
 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

/** 监听一个**非禁用**的临时端口（拿到禁用端口就关掉重听）。 */
const listenOnUsablePort = async (server) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.removeListener('listening', onListening); reject(e) }
      const onListening = () => { server.removeListener('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    const port = server.address().port
    if (!BLOCKED_PORTS.has(port)) return port
    await new Promise((resolve) => server.close(resolve))
  }
  throw new Error('could not obtain a fetch-usable ephemeral port for the test gateway')
}

/**
 * 起一个"网关实例"：真实 http.Server + 真实 apply(ctx)。
 * 同一 assocRoot 再起一个实例 = 模拟"网关重载/新实例"。
 */
export const startGateway = async (options) => {
  const { apply } = await loadBridge()
  const handlers = new Map()
  const starts = []
  const prompts = []
  const owners = []
  const followups = []
  const routeErrors = []
  const cleanups = []
  const ctxHandlers = new Map()
  const agentHandlers = new Map()
  const childTexts = new Map()
  const childIdOf = (text) => {
    let hash = 0
    for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0
    return 'child-' + Math.abs(hash).toString(36)
  }
  const onCtx = (name, fn) => {
    const set = ctxHandlers.get(name) || new Set()
    set.add(fn)
    ctxHandlers.set(name, set)
    return () => set.delete(fn)
  }
  const onAgent = (name, fn) => {
    const set = agentHandlers.get(name) || new Set()
    set.add(fn)
    agentHandlers.set(name, set)
    return () => set.delete(fn)
  }
  const controller = {
    async resolveAgent(sessionId) { return { sessionId } },
    async prompt(args) { prompts.push(args); return {} },
    // options.follow 用于注入 follow 帧（含开场 snapshot）；options.events 是"读日志"能看到的事件。
    async *follow() { if (options.follow) yield* options.follow() },
    async cancel() { return {} },
  }
  /** 假 timer：把 interval 回调收起来，测试可显式触发一次 sweep（真实 profile 由 timer 服务按 2.5s 跑）。 */
  const intervals = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const handler = handlers.get(url.pathname)
    if (handler === undefined) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        // 路由里未捕获的异常：记下来（诊断用），并如实回 500（而不是静默成空 body）
        routeErrors.push({ path: url.pathname, message: String((e && e.stack) || e) })
        console.error('[test-host] route ' + url.pathname + ' failed: ' + ((e && e.stack) || e))
        try { res.writeHead(500); res.end(String((e && e.message) || e)) } catch (e2) { /* already sent */ }
      })
  })
  const port = await listenOnUsablePort(server)

  const ctx = {
    webServer: {
      register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path) },
      registerUpgrade() { return () => {} },
    },
    agents: {
      list() { return [{ options: { provider: 'fake-provider', model: 'fake-model' } }] },
      async create(options) {
        owners.push(options)
        return { agent: { id: 'owner-1', ctx: { on: onAgent } }, dispose() {} }
      },
    },
    subagents: {
      list() { return ['subagent'] },
      getProvider() { return { prepareContinuable() {} } },
      async startContinuable(args) {
        starts.push(args)
        const text = String(args && args.request && args.request.prompt && args.request.prompt[0] && args.request.prompt[0].text || '')
        const childId = childIdOf(text)
        childTexts.set(childId, text)
        return { childId }
      },
      async followup(args) { followups.push(args); return {} },
      interrupt() {},
    },
    tools: { register() { return () => {} } },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'sessionQuery') return { async readSession() { return { events: options.events || [] } } }
      if (name === 'timer') return { interval: (fn) => { intervals.push(fn); return () => {} } }
      return undefined
    },
    on: onCtx,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  const previous = process.env.DSH_BRIDGE_ASSOC_DIR
  const previousExtra = new Map()
  process.env.DSH_BRIDGE_ASSOC_DIR = options.assocRoot
  for (const [key, value] of Object.entries(options.env || {})) {
    previousExtra.set(key, process.env[key])
    process.env[key] = String(value)
  }
  try {
    await apply(ctx)
  } finally {
    if (previous === undefined) delete process.env.DSH_BRIDGE_ASSOC_DIR
    else process.env.DSH_BRIDGE_ASSOC_DIR = previous
    for (const [key, value] of previousExtra) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const instance = {
    url: 'http://127.0.0.1:' + port,
    port,
    assocRoot: options.assocRoot,
    starts,
    prompts,
    owners,
    followups,
    /** 路由里未捕获异常（诊断用；正常情况下应为空）。 */
    routeErrors,
    /** 已注册 child 对应的指令文本（诊断用：能看到到底有没有真正启动 worker）。 */
    childMarkers() { return Array.from(childTexts.values()) },
    /**
     * **有上限地**等待某个指令对应的 child 真正注册（HTTP 202 只表示"已接受"，不代表已启动）。
     * 不是固定长 sleep：条件满足立刻返回；超时才返回 false，由调用方带诊断断言。
     */
    async waitForChild(marker, waitOptions = {}) {
      const timeoutMs = typeof waitOptions.timeoutMs === 'number' ? waitOptions.timeoutMs : 5000
      const intervalMs = typeof waitOptions.intervalMs === 'number' ? waitOptions.intervalMs : 20
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (Array.from(childTexts.values()).some((t) => t.includes(marker))) return true
        if (Date.now() > deadline) return false
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    },
    /** 精确结清"指令里包含 marker 的那个任务"。 */
    complete(marker, text, stopReason = 'end_turn') {
      for (const [childId, instruction] of childTexts) {
        if (!instruction.includes(marker)) continue
        for (const fn of agentHandlers.get('subagent/end') || []) fn({ id: childId, lastAssistantMessage: [{ type: 'text', text }], stopReason })
        return true
      }
      return false
    },
    emitCtx(name, ...args) {
      for (const fn of ctxHandlers.get(name) || []) fn(...args)
    },
    /** 显式触发一次 2.5s sweep（含会话轮询/超时兜底），并等回调里的异步收尾跑完。 */
    async runIntervals(settleMs = 60) {
      for (const fn of intervals) fn()
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    },
    async close() {
      for (const cleanup of cleanups) { try { cleanup() } catch (e) { /* ignore */ } }
      await new Promise((resolve) => server.close(resolve))
    },
  }
  gateways.push(instance)
  return instance
}

// ---------------------------------------------------------------- 独立 MCP 进程（stdio JSON-RPC）

export const mcpCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
export const mcpInit = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
export const payloadOf = (response) => JSON.parse(response.result.content[0].text)

/** 跑一个 MCP 进程：所有响应按 id 收齐后 kill，并**等到 close** 才 resolve。 */
export const runMcp = (env, requests, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [MCP_PATH], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  let buffer = ''
  const got = new Map()
  const stderr = []
  let settled = false
  const finish = async (error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { child.kill() } catch (e) { /* ignore */ }
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) return r()
      child.once('close', r)
      setTimeout(r, 3000)
    })
    if (error !== undefined) reject(error)
    else resolve(got)
  }
  const timer = setTimeout(() => { void finish(new Error('MCP timeout; stderr=' + stderr.join(''))) }, timeoutMs)
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') {
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined) got.set(msg.id, msg)
        } catch (e) { /* ignore non-JSON */ }
      }
      idx = buffer.indexOf('\n')
    }
    if (got.size >= requests.length) void finish()
  })
  child.stderr.on('data', (d) => stderr.push(String(d)))
  child.on('error', (e) => { void finish(e) })
  for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n')
})

// ---------------------------------------------------------------- 独立 CLI 进程

/** 必须异步：网关 HTTP 服务器就跑在调用方进程里，spawnSync 会阻塞事件循环 → 自锁。 */
export const runCli = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', reject)
  child.on('close', (code) => resolve({ status: code, stdout, stderr }))
})
