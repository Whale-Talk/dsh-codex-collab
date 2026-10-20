/**
 * 模型路由**入口**回归（真实进程 + 真实 HTTP 捕获）：
 *  1. HTTP `/review` 真正接入任务级模型路由（auto 选 DeepSeek / 显式 pair / 精确缺失零派活 / route 回显 + 审计）；
 *  2. 真实 CLI 进程：`task.mjs` 的 session（--session 与 --find 两种写法）和 worker 都必须把 **provider+model** 成对发出；
 *  3. 真实 CLI 进程：`review.mjs` 的 --model/--provider/--model-fallback/--origin 必须真的进 POST，旧网关零派活、缺来源 exit2；
 *  4. 真实 MCP 进程：`dsh_review` 的模型字段透传与旧网关零派活。
 * 全部只连本机 loopback 捕获服务器/测试网关，不向真实 DSH 派活、不读凭据。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { disposeAll, makeTmp, startGateway, runMcp, mcpInit, mcpCall, payloadOf } from './helpers/dsh-host.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const TASK_CLI = path.join(repoRoot, 'codex-plugin', 'plugins', 'dsh', 'skills', 'dsh-collab', 'scripts', 'task.mjs')
const REVIEW_CLI = path.join(repoRoot, 'codex-plugin', 'plugins', 'dsh', 'skills', 'dsh-collab', 'scripts', 'review.mjs')

const offlineLlm = () => ({
  async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'alternate-offline' }] },
  async listModels(provider) {
    if (provider === 'deepseek-offline') return [{ id: 'primary' }]
    if (provider === 'alternate-offline') return [{ id: 'alternate' }]
    throw new Error('unknown provider')
  },
  async resolveModelInfo(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128000 }, reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } } },
})

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json = null
  try { json = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json }
}

/** 运行任意 CLI 脚本（真实子进程）。 */
const runScript = (script, args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d.toString() })
  child.stderr.on('data', (d) => { stderr += d.toString() })
  child.on('error', reject)
  child.on('close', (code) => resolve({ status: code === null ? 1 : code, stdout, stderr }))
})

/**
 * 捕获用网关：返回真实形状的 capabilities，记录每个 POST 请求体，可控"是否支持模型路由"。
 * 不执行任何任务（只为真实进程/网络体断言）。
 */
const startCapture = async ({ modelRouting = true, originBinding = true } = {}) => {
  const posts = []
  const gets = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method === 'GET') {
        gets.push(url.pathname + url.search)
        // 轮询：带 taskId 的 status 查询返回终态；能力探测（无 taskId）返回 capabilities
        if (url.pathname === '/api/dsh-bridge/status' && url.searchParams.get('taskId') === null) {
          return send(200, {
            capabilities: {
              originBinding: originBinding ? { supported: true, version: 1 } : { supported: false },
              modelRouting: modelRouting ? { supported: true, defaultMode: 'auto', maxCandidates: 3, firstRequestBinding: 'agent/inbox/claimed' } : { supported: false },
              approvals: { supported: true, enabled: true },
              delivery: { supported: true },
            },
          })
        }
        if (url.pathname === '/api/dsh-bridge/sessions') {
          return send(200, { ok: true, sessions: [{ sessionId: 'sess-captured', snippet: 'captured session', title: 'captured' }] })
        }
        return send(200, { status: 'done', taskId: url.searchParams.get('taskId') || 'captured-task', result: 'ok' })
      }
      const body = text === '' ? {} : JSON.parse(text)
      posts.push({ path: url.pathname, body })
      if (url.pathname === '/api/dsh-bridge/review') return send(202, { taskId: 'captured-review', status: 'accepted', kind: 'review', originThreadId: body.originThreadId, route: { mode: 'auto', chosen: { provider: 'deepseek-offline', model: 'primary' } } })
      if (url.pathname === '/api/dsh-bridge/task') return send(202, { taskId: 'captured-task', status: 'accepted', kind: 'task', originThreadId: body.originThreadId, route: { mode: 'auto', chosen: { provider: 'deepseek-offline', model: 'primary' } } })
      return send(202, { taskId: 'captured-other', status: 'accepted' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    posts,
    gets,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

after(async () => { await disposeAll() })

test('HTTP /review：默认 auto 真正选 DeepSeek、显式 pair 生效、精确缺失零派活、route 回显与审计', async () => {
  const gateway = await startGateway({ assocRoot: await makeTmp('entry-assoc-'), events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('entry-store-') } })
  const origin = 'entry-origin'
  try {
    const auto = await post(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/tmp/entry-review', diff: 'x', focus: 'y', originThreadId: origin })
    assert.equal(auto.status, 202, JSON.stringify(auto.body))
    assert.equal(auto.body.kind, 'review')
    assert.equal(auto.body.originThreadId, origin)
    assert.deepEqual(auto.body.route.chosen, { provider: 'deepseek-offline', model: 'primary' }, '评审默认 auto 必须真正选择 DeepSeek 而不是机器基线: ' + JSON.stringify(auto.body.route))
    assert.equal(gateway.starts.length, 1, '评审必须真的启动评审子代理')
    // 精确 pair 生效
    const exact = await post(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/tmp/entry-review2', diff: 'x', originThreadId: origin, provider: 'alternate-offline', model: 'alternate', modelFallback: false })
    assert.equal(exact.status, 202, JSON.stringify(exact.body))
    assert.deepEqual(exact.body.route.chosen, { provider: 'alternate-offline', model: 'alternate' })
    // 精确 pair 不在目录 → 零派活拒绝（评审也不跑"另一个模型"）
    const before = gateway.starts.length
    const missing = await post(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/tmp/entry-review3', diff: 'x', originThreadId: origin, provider: 'nope', model: 'ghost' })
    assert.equal(missing.status, 400, JSON.stringify(missing.body))
    assert.equal(missing.body.reason, 'model-route-invalid')
    assert.equal(gateway.starts.length, before, '精确缺失必须零派活')
    // 审计：同 origin 可查到评审任务的 plan（kind=review、businessKind=review、execution=worker）
    const status = await (await fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(auto.body.taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(status.kind, 'review')
    assert.equal(status.route.mode, 'auto')
    assert.equal(Array.isArray(status.routeAudit) && status.routeAudit.length > 0, true, '评审必须有独立审计')
    assert.equal(status.routeAudit.some((e) => e.kind === 'plan' && e.taskKind === 'review' && e.execution === 'worker'), true, '审计必须记录 review/worker: ' + JSON.stringify(status.routeAudit))
  } finally { await gateway.close() }
})

test('真实 CLI task.mjs：session（--session 与 --find）与 worker 都必须成对发出 provider+model+modelFallback+origin', async () => {
  const cap = await startCapture()
  const env = { DSH_BRIDGE_URL: cap.url }
  try {
    // ① --session 精确 pair（此前 model 只在 worker 分支发送 → 这里必须真的出现）
    const session = await runScript(TASK_CLI, ['--in', 'x', '--session', 'sess-captured', '--provider', 'alternate-offline', '--model', 'alternate', '--origin', 'origin-cli-capture', '--no-model-fallback', '--no-wait'], env)
    assert.equal(session.status, 0, session.stderr)
    const sessionPost = cap.posts.filter((p) => p.path === '/api/dsh-bridge/task').at(-1)
    assert.ok(sessionPost, 'CLI 必须真的 POST')
    assert.equal(sessionPost.body.model, 'alternate', '--session 的 --model 必须进 POST: ' + JSON.stringify(sessionPost.body))
    assert.equal(sessionPost.body.provider, 'alternate-offline')
    assert.equal(sessionPost.body.modelFallback, false)
    assert.equal(sessionPost.body.sessionId, 'sess-captured')
    assert.equal(sessionPost.body.originThreadId, 'origin-cli-capture')

    // ② --find（sessionQuery 写法）同样带上模型身份对
    const found = await runScript(TASK_CLI, ['--in', 'x', '--find', 'captured', '--provider', 'alternate-offline', '--model', 'alternate', '--origin', 'origin-cli-capture', '--no-wait'], env)
    assert.equal(found.status, 0, found.stderr)
    const findPost = cap.posts.filter((p) => p.path === '/api/dsh-bridge/task').at(-1)
    assert.equal(findPost.body.model, 'alternate', '--find 写法同样不能丢 model: ' + JSON.stringify(findPost.body))
    assert.equal(findPost.body.provider, 'alternate-offline')
    assert.ok(findPost.body.sessionId !== undefined || findPost.body.sessionQuery !== undefined, '--find 必须带上会话定位字段: ' + JSON.stringify(findPost.body))

    // ③ worker 写法保持
    const worker = await runScript(TASK_CLI, ['--in', 'x', '--cwd', 'E:/tmp/entry-worker', '--provider', 'alternate-offline', '--model', 'alternate', '--origin', 'origin-cli-capture', '--model-fallback', '--no-wait'], env)
    assert.equal(worker.status, 0, worker.stderr)
    const workerPost = cap.posts.filter((p) => p.path === '/api/dsh-bridge/task').at(-1)
    assert.equal(workerPost.body.model, 'alternate')
    assert.equal(workerPost.body.provider, 'alternate-offline')
    assert.equal(workerPost.body.modelFallback, true)

    // ④ --model 缺值必须 exit2 且零 POST（绝不静默变 auto）
    const beforeMissing = cap.posts.filter((p) => p.path === '/api/dsh-bridge/task').length
    const missing = await runScript(TASK_CLI, ['--in', 'x', '--session', 's', '--model', '--no-wait'], env)
    assert.equal(missing.status, 2, '--model 缺值必须 exit2: ' + missing.stderr)
    assert.equal(cap.posts.filter((p) => p.path === '/api/dsh-bridge/task').length, beforeMissing, '--model 缺值必须零请求')
  } finally { await cap.close() }
})

test('真实 CLI review.mjs：模型/来源参数真的进 POST；旧网关零派活；缺来源 exit2；后续 status 带 origin', async () => {
  const cap = await startCapture()
  try {
    const ok = await runScript(REVIEW_CLI, ['--cwd', repoRoot, '--diff', 'x', '--focus', 'y', '--model', 'alternate', '--provider', 'alternate-offline', '--no-model-fallback', '--origin', 'origin-review-capture', '--timeout', '3'], { DSH_BRIDGE_URL: cap.url })
    assert.equal(ok.status, 0, ok.stderr + ok.stdout)
    const reviewPost = cap.posts.filter((p) => p.path === '/api/dsh-bridge/review').at(-1)
    assert.ok(reviewPost, 'review.mjs 必须真的 POST /review')
    assert.equal(reviewPost.body.model, 'alternate', 'review CLI 的 --model 必须进 POST: ' + JSON.stringify(reviewPost.body))
    assert.equal(reviewPost.body.provider, 'alternate-offline')
    assert.equal(reviewPost.body.modelFallback, false)
    assert.equal(reviewPost.body.originThreadId, 'origin-review-capture')
    assert.equal(cap.gets.some((g) => g.startsWith('/api/dsh-bridge/status?taskId=') && g.includes('originThreadId=origin-review-capture')), true, '后续 status 轮询必须带来源')
    // 缺来源（无 --origin 且无 CODEX_THREAD_ID）→ exit2 零 POST
    const noOrigin = await runScript(REVIEW_CLI, ['--cwd', repoRoot, '--diff', 'x', '--timeout', '1'], { DSH_BRIDGE_URL: cap.url, CODEX_THREAD_ID: '' })
    assert.equal(noOrigin.status, 2, '缺来源必须 exit2: ' + noOrigin.stderr)
    assert.equal(cap.posts.filter((p) => p.path === '/api/dsh-bridge/review').length, 1, '缺来源必须零 POST')
  } finally { await cap.close() }

  // 旧网关：没有 capabilities.modelRouting → 带模型参数的评审零派活
  const bare = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ capabilities: { originBinding: { supported: true }, approvals: { supported: true }, delivery: { supported: true } } })); return }
    res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ taskId: 'should-not-happen' }))
  })
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve))
  const posts = []
  bare.on('request', (req) => { if (req.method === 'POST') posts.push(req.url) })
  try {
    const old = await runScript(REVIEW_CLI, ['--cwd', repoRoot, '--diff', 'x', '--model', 'auto', '--origin', 'origin-review-old', '--timeout', '1'], { DSH_BRIDGE_URL: 'http://127.0.0.1:' + bare.address().port })
    assert.equal(old.status, 2, '旧网关带模型参数必须零派活拒绝: ' + old.stderr)
    assert.match(old.stderr, /modelRouting/)
    assert.equal(posts.filter((p) => p === '/api/dsh-bridge/review').length, 0, '旧网关必须零 review POST')
  } finally { await new Promise((resolve) => bare.close(resolve)) }
})

test('失败收口：worker/reviewer 的 subagent 失败 stopReason 绝不算 done（空文本也不当作失败判据）', async () => {
  const gateway = await startGateway({ assocRoot: await makeTmp('fin-assoc-'), events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('fin-store-') } })
  const origin = 'finalize-origin'
  try {
    // ① worker：失败 stopReason='error' → error（即使 end 事件到了也不是 done）
    const worker = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'finalize-worker-marker', cwd: 'E:/tmp/fin-worker', originThreadId: origin })
    assert.equal(worker.status, 202, JSON.stringify(worker.body))
    assert.equal(await gateway.waitForChild('finalize-worker-marker'), true)
    assert.equal(gateway.complete('finalize-worker-marker', '', 'error'), true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const workerStatus = await (await fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(worker.body.taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(workerStatus.status, 'error', '失败 stopReason 必须收口 error，绝不能 done+(无输出): ' + JSON.stringify(workerStatus))
    assert.equal(workerStatus.reason, 'subagent-turn-failed')
    assert.match(String(workerStatus.error), /subagent turn ended as "error"/, '错误必须携带真实 stopReason')
    assert.equal(workerStatus.result, undefined, '失败终态不得带 result=(无输出)')

    // ② 成功 stopReason + 空文本 → done（空文本不是失败判据）
    const okWorker = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'finalize-empty-ok-marker', cwd: 'E:/tmp/fin-worker2', originThreadId: origin })
    assert.equal(okWorker.status, 202, JSON.stringify(okWorker.body))
    assert.equal(await gateway.waitForChild('finalize-empty-ok-marker'), true)
    assert.equal(gateway.complete('finalize-empty-ok-marker', '', 'end_turn'), true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const okStatus = await (await fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(okWorker.body.taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(okStatus.status, 'done', '成功结束且文本空 → done（不因空文本判失败）: ' + JSON.stringify(okStatus))

    // ③ reviewer：同样按 stopReason 收口（禁 fallback 的 AUTH 终态在真实 SDK 里就是 error）
    const review = await post(gateway.url + '/api/dsh-bridge/review', { cwd: 'E:/tmp/fin-review-marker', diff: 'x', originThreadId: origin })
    assert.equal(review.status, 202, JSON.stringify(review.body))
    assert.equal(await gateway.waitForChild('【变更 diff】'), true)
    assert.equal(gateway.complete('【变更 diff】', '', 'error'), true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const reviewStatus = await (await fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(review.body.taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(reviewStatus.status, 'error', '评审失败 stopReason 必须收口 error: ' + JSON.stringify(reviewStatus))
    assert.equal(reviewStatus.reason, 'subagent-turn-failed')
  } finally { await gateway.close() }
})

test('真实 MCP dsh_review：模型字段透传 + 旧网关零派活；工具数量仍是 9', async () => {
  const cap = await startCapture()
  const env = { DSH_BRIDGE_URL: cap.url, CODEX_THREAD_ID: '' }
  try {
    const mcp = await runMcp(env, [mcpInit(0), mcpCall(1, 'dsh_review', { cwd: 'E:/tmp/entry-mcp-review', diff: 'x', focus: 'y', originThreadId: 'origin-mcp-review', model: 'alternate', provider: 'alternate-offline', modelFallback: false, wait: false, timeoutSec: 2 })], 20000)
    const reviewPost = cap.posts.filter((p) => p.path === '/api/dsh-bridge/review').at(-1)
    assert.ok(reviewPost, 'MCP dsh_review 必须真的 POST')
    assert.equal(reviewPost.body.model, 'alternate', 'MCP dsh_review 的 model 必须透传: ' + JSON.stringify(reviewPost.body))
    assert.equal(reviewPost.body.provider, 'alternate-offline')
    assert.equal(reviewPost.body.modelFallback, false)
    assert.equal(reviewPost.body.originThreadId, 'origin-mcp-review')
    const response = payloadOf(mcp.get(1))
    assert.equal(response.ok, true, JSON.stringify(response))
  } finally { await cap.close() }

  // 工具数量仍是 9（不因评审入口新增工具）；dsh_models 不再宣称未实现的 origin 审计参数
  const gateway = await startGateway({ assocRoot: await makeTmp('entry-tools-'), events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('entry-tools-store-') } })
  try {
    const listRes = await runMcp({ DSH_BRIDGE_URL: gateway.url, CODEX_THREAD_ID: '' }, [mcpInit(0), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], 20000)
    const tools = listRes.get(1).result.tools
    const names = tools.map((t) => t.name).sort()
    assert.equal(names.length, 9, 'MCP 工具必须仍是 9 个: ' + JSON.stringify(names))
    const modelsTool = tools.find((t) => t.name === 'dsh_models')
    assert.equal(modelsTool !== undefined, true)
    assert.equal(String(modelsTool.description).includes('originThreadId'), false, 'dsh_models 不再宣称未实现的 origin 审计参数')
    const reviewTool = tools.find((t) => t.name === 'dsh_review')
    assert.equal(typeof reviewTool.inputSchema.properties.model, 'object', 'dsh_review schema 必须带 model')
    assert.equal(typeof reviewTool.inputSchema.properties.provider, 'object', 'dsh_review schema 必须带 provider')
    assert.equal(typeof reviewTool.inputSchema.properties.modelFallback, 'object', 'dsh_review schema 必须带 modelFallback')
  } finally { await gateway.close() }
})
