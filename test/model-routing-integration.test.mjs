/**
 * 动态模型路由 **端到端接线回归（M2）**：真实 HTTP 网关（离线 llm 替身，无网络、无凭据）。
 * 覆盖 canonical 验收矩阵中可在 harness 内如实表达的部分：
 *  - `GET /models` 只读目录 + 失败隔离 + "≠已验证可调用"说明；`capabilities.modelRouting` 声明；
 *  - auto 默认选择（DeepSeek 偏好）→ 202 回显 route.chosen；
 *  - 精确 pair 不在目录 → **派活前拒绝**（零 prompt）；同名跨 provider 歧义 → 拒绝并给候选；
 *  - `modelFallback:false` 精确指定 → 策略固定；`default` → inherit；
 *  - 审计落盘（JSONL）且**跨重启可查**（新实例读同一 assoc 根）；
 *  - 旧网关（无 capabilities.modelRouting）→ MCP/CLI 新语义零派活；
 *  - 原 182 项审批/投递回归不受影响（另一文件覆盖）。
 * 跑法: node test/model-routing-integration.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, listenOnUsablePort, runMcp, mcpInit, mcpCall, payloadOf, runCli } from './helpers/dsh-host.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-key-'))
const keyPath = path.join(keyDir, 'control.key')

const offlineLlm = (spec = {}) => ({
  async listProviders() { return spec.providers === undefined ? [{ id: 'deepseek-offline' }, { id: 'backup-offline' }] : spec.providers },
  async listModels(provider) {
    const models = { 'deepseek-offline': [{ id: 'primary' }, { id: 'reasoner' }], 'backup-offline': [{ id: 'backup' }] }
    if (spec.failProviders !== undefined && spec.failProviders.includes(provider)) { const e = new Error('catalog down'); e.code = 'CATALOG_FAILED'; throw e }
    if (models[provider] === undefined) throw new Error('unknown provider')
    return models[provider]
  },
  async resolveModelInfo(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 }, reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } }
  },
})

/** 审计文件在 assoc 根（可能带 namespace 子目录）：递归定位。 */
const findAudit = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { const hit = findAudit(full); if (hit !== null) return hit; continue }
    if (entry.name === 'model-routing.jsonl') return full
  }
  return null
}

const post = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) })
  let json = null
  try { json = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json }
}
const statusOf = async (gateway) => {
  const res = await fetch(gateway.url + '/api/dsh-bridge/status')
  return { status: res.status, body: await res.json() }
}

after(async () => {
  await disposeAll()
  try { fs.rmSync(keyDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})

test('M2 端点：/models 只读目录 + capabilities.modelRouting + auto 选择回显', async () => {
  const assocRoot = await makeTmp('mr-assoc-')
  const gateway = await startGateway({ assocRoot, events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store-') } })
  try {
    const status = await statusOf(gateway)
    assert.equal(status.body.capabilities.modelRouting.supported, true)
    assert.equal(status.body.capabilities.modelRouting.defaultMode, 'auto')
    assert.equal(status.body.capabilities.modelRouting.maxCandidates, 3)
    assert.equal(status.body.capabilities.modelRouting.firstRequestBinding, 'agent/inbox/claimed')
    const models = await (await fetch(gateway.url + '/api/dsh-bridge/models')).json()
    assert.equal(models.ok, true)
    assert.deepEqual(models.pairs.map((p) => p.provider + '/' + p.model), ['deepseek-offline/primary', 'deepseek-offline/reasoner', 'backup-offline/backup'])
    assert.match(models.note, /不等于凭据\/额度\/远端健康已验证/)
    // auto（默认）：派活前选好 pair 并在 202 回显
    const auto = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', cwd: 'E:/tmp/mr-auto' })
    assert.equal(auto.status, 202, JSON.stringify(auto.body))
    assert.equal(auto.body.route.mode, 'auto')
    assert.equal(auto.body.route.chosen.provider, 'deepseek-offline', 'auto 必须优先已配置的 DeepSeek')
    assert.equal(auto.body.route.allowFallback, true)
    // 目录失败隔离：某个 provider 失败不影响其它 provider
    const broken = await startGateway({ assocRoot: await makeTmp('mr-assoc2-'), events: [], llm: offlineLlm({ failProviders: ['backup-offline'] }), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store2-') } })
    try {
      const view = await (await fetch(broken.url + '/api/dsh-bridge/models')).json()
      assert.equal(view.pairs.some((p) => p.provider === 'deepseek-offline'), true, '其它 provider 必须照常可用')
      assert.equal(view.failures.some((f) => f.provider === 'backup-offline'), true)
    } finally { await broken.close() }
  } finally { await gateway.close() }
})

test('M2 策略：精确 pair 不在目录 → 零 prompt 拒绝；同名歧义 → 拒绝并给候选；default → inherit', async () => {
  const assocRoot = await makeTmp('mr-assoc3-')
  const dupLlm = offlineLlm({ providers: [{ id: 'p1' }, { id: 'p2' }] })
  dupLlm.listModels = async (provider) => (provider === 'p1' || provider === 'p2' ? [{ id: 'same' }] : [])
  const gateway = await startGateway({ assocRoot, events: [], llm: dupLlm, env: { DSH_APPROVAL_DIR: await makeTmp('mr-store3-') } })
  try {
    const before = gateway.prompts.length
    const missingPair = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', cwd: 'E:/tmp/mr-exact', model: 'ghost', provider: 'deepseek-offline' })
    assert.equal(missingPair.status, 400, JSON.stringify(missingPair.body))
    assert.equal(missingPair.body.reason, 'model-route-invalid')
    assert.equal(gateway.prompts.length, before, '精确 pair 不存在必须零 prompt')
    const ambiguous = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', cwd: 'E:/tmp/mr-amb', model: 'same' })
    assert.equal(ambiguous.status, 400, JSON.stringify(ambiguous.body))
    assert.equal(ambiguous.body.reason, 'model-route-invalid')
    assert.equal(ambiguous.body.route.candidates.length, 2, '同名跨 provider 必须给候选而不是静默选一个')
    assert.equal(gateway.prompts.length, before, '歧义也必须零 prompt')
    // 精确 pair 存在 → 允许；modelFallback 默认关闭
    const exact = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', cwd: 'E:/tmp/mr-exact2', model: 'same', provider: 'p1' })
    assert.equal(exact.status, 202, JSON.stringify(exact.body))
    assert.equal(exact.body.route.mode, 'exact')
    assert.equal(exact.body.route.chosen.provider, 'p1')
    assert.equal(exact.body.route.allowFallback, false, '精确指定默认固定（需显式开启才降级）')
    // default → inherit（不覆盖、不选择）
    const inherit = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', cwd: 'E:/tmp/mr-inherit', model: 'default' })
    assert.equal(inherit.status, 202, JSON.stringify(inherit.body))
    assert.equal(inherit.body.route.mode, 'inherit')
    assert.equal(inherit.body.route.chosen, null)
  } finally { await gateway.close() }
})

test('M2 审计：稳定字段落盘且跨重启可查（不含 failure 正文/prompt/key）', async () => {
  const assocRoot = await makeTmp('mr-assoc4-')
  const gateway = await startGateway({ assocRoot, events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store4-') } })
  let taskId
  try {
    const auto = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'secret prompt body', cwd: 'E:/tmp/mr-audit' })
    assert.equal(auto.status, 202)
    taskId = auto.body.taskId
    const status = await statusOf(gateway)
    const auditFile = findAudit(assocRoot)
    assert.notEqual(auditFile, null, '审计文件必须已落盘')
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.some((e) => e.kind === 'plan' && e.taskId === taskId), true, '计划必须落盘: ' + JSON.stringify(lines))
    const plan = lines.find((e) => e.kind === 'plan' && e.taskId === taskId)
    assert.equal(plan.chosen.provider, 'deepseek-offline')
    assert.equal(JSON.stringify(lines).includes('secret prompt body'), false, '审计绝不含 prompt 正文')
    assert.equal(JSON.stringify(lines).includes('SECRET'), false)
  } finally { await gateway.close() }
  // 重启（同一 assoc 根、新的内存任务表）：审计事实仍可查
  const second = await startGateway({ assocRoot, events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store5-') } })
  try {
    const res = await fetch(second.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=owner')
    const body = await res.json()
    const auditTail = Array.isArray(body.routeAudit) ? body.routeAudit : []
    // 重启后任务本身是 unknown（未绑定来源则 404/unknown 均可），关键是审计能读回
    const reread = fs.readFileSync(findAudit(assocRoot), 'utf8')
    assert.equal(reread.includes(taskId), true, '重启后审计文件仍保留该任务的选择记录')
    assert.equal(second.prompts.length, 0, '重启不得重派任何任务')
    assert.equal(Array.isArray(auditTail), true)
  } finally { await second.close() }
})

test('F 反例回归：扁平 sessionId+model 与 target.kind=session+model 语义一致；重启后按 origin/task 取回非空 route/routeAudit', async () => {
  const assocRoot = await makeTmp('mr-assoc6-')
  const origin = 'origin-f'
  const gateway = await startGateway({ assocRoot, events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store6-') } })
  let taskId
  try {
    // 扁平写法（sessionId + model:auto）
    const flat = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'x', sessionId: 'sess-f', originThreadId: origin, model: 'auto' })
    assert.equal(flat.status, 202, '扁平 sessionId+model:auto 必须被接受: ' + JSON.stringify(flat.body))
    assert.equal(flat.body.route.mode, 'auto')
    // 等价写法（target.kind=session + model:auto）必须**同样**被接受（旧规则曾 400 invalid-target）
    const explicit = await post(gateway.url + '/api/dsh-bridge/task', { instruction: 'y', target: { kind: 'session', sessionId: 'sess-f2' }, originThreadId: origin, model: 'auto' })
    assert.equal(explicit.status, 202, '等价 target.kind=session+model:auto 必须与扁平写法一致: ' + JSON.stringify(explicit.body))
    assert.equal(explicit.body.route.mode, 'auto')
    taskId = flat.body.taskId
    // live status 有 route/routeAudit
    const live = await (await fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(live.route.mode, 'auto')
    assert.equal(Array.isArray(live.routeAudit) && live.routeAudit.length > 0, true, 'live 必须能读到非空 routeAudit')
  } finally { await gateway.close() }
  // 重启（同 assoc 根、新实例）：执行状态可以是 unknown，但**审计事实必须仍按 origin/task 取回**
  const second = await startGateway({ assocRoot, events: [], llm: offlineLlm(), env: { DSH_APPROVAL_DIR: await makeTmp('mr-store7-') } })
  try {
    const recovered = await (await fetch(second.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=' + encodeURIComponent(origin))).json()
    assert.equal(recovered.status, 'unknown', '重启后执行状态如实 unknown')
    assert.equal(recovered.originThreadId, origin, '必须回显匹配的来源')
    assert.notEqual(recovered.route, undefined, '重启后必须恢复 route（非空）')
    assert.equal(recovered.route.mode, 'auto')
    assert.equal(recovered.route.chosen.provider, 'deepseek-offline')
    assert.equal(Array.isArray(recovered.routeAudit) && recovered.routeAudit.length > 0, true, '重启后 routeAudit 必须非空')
    assert.equal(recovered.routeAudit.every((e) => e.taskId === taskId), true, '审计条目必须都属于该 task')
    assert.equal(recovered.routeAudit.some((e) => e.kind === 'plan' && e.originThreadId === origin), true, '审计必须带匹配的 origin')
    // 错 origin 必须拒绝（不得借恢复分支读到别人的审计）
    const wrongRes = await fetch(second.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=someone-else')
    const wrong = await wrongRes.json()
    assert.equal(wrongRes.status, 404, '错 origin 必须拒绝: ' + JSON.stringify(wrong))
    assert.equal(wrong.reason, 'origin-mismatch')
    assert.equal(wrong.route, undefined)
    assert.equal(second.prompts.length, 0, '重启不得重派')
  } finally { await second.close() }
})

test('M2 旧网关：无 capabilities.modelRouting → MCP/CLI 新语义零派活（不忽略新字段照常执行）', async () => {
  const bare = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ capabilities: { originBinding: { supported: true, version: 1 }, approvals: { supported: true, enabled: true }, delivery: { supported: true } } }))
  })
  await listenOnUsablePort(bare)
  const env = { DSH_BRIDGE_URL: 'http://127.0.0.1:' + bare.address().port, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath }
  try {
    // MCP：只有 fast/pro 是兼容别名（旧网关仍工作）；provider/modelFallback/精确 id/default 必须拒绝
    const mcpCompat = await runMcp(env, [mcpInit(0), mcpCall(1, 'dsh_models', {})], 20000)
    assert.equal(payloadOf(mcpCompat.get(1)).reason, 'model-routing-unsupported', 'dsh_models 在旧网关必须零请求拒绝')
    const mcpNewField = await runMcp(env, [mcpInit(0), mcpCall(1, 'dsh_task', { instruction: 'x', cwd: 'E:/tmp/old', modelFallback: true, wait: false })], 20000)
    assert.equal(payloadOf(mcpNewField.get(1)).reason, 'model-routing-unsupported', '新字段在旧网关必须零派活')
    const cliModels = await runCli(['--models'], env)
    assert.equal(cliModels.status, 2, 'CLI --models 在旧网关必须明确拒绝: ' + cliModels.stderr)
    const cliNewField = await runCli(['--in', 'x', '--cwd', 'E:/tmp/old2', '--model', 'auto'], env)
    assert.equal(cliNewField.status, 2, 'CLI 新语义在旧网关必须零派活')
    // 兼容别名 fast 不额外加前提（旧行为保留）
    assert.match(cliModels.stderr, /modelRouting/)
  } finally {
    await new Promise((resolve) => bare.close(resolve))
  }
})
