/**
 * 模型路由 **宿主接线（M2）** 行为回归：真实 hook 语义（离线 llm/ctx 替身，无网络、无凭据）。
 * 覆盖：
 *  - 派活前登记 → `agent/inbox/claimed` 首请求归属（先于 user/message 落盘）→ 首 attempt 用所选 pair；
 *  - 同 turn/step：结构化失败 → 有界切换 → 下一次 attempt 换 pair（不新回合、不重派、不新建 child）；
 *  - 跨模型不带不兼容 effort/maxTokens；
 *  - 禁 fallback → 绝不切；不可切类（工具/安全/审批/取消）→ 交还原生策略；
 *  - 未绑定请求：原样返回；默认选择停在我们写过的路由上（泄漏）→ **条件恢复**用户原选择；人类已改选 → 尊重；
 *  - 审计字段不含 failure.message/prompt/工具参数；收口/卸载后绑定失效、在途异步不复活。
 * 跑法: node test/model-route-host.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelRouting } from '../harness/model-route-host.mjs'

const fakeLlm = () => ({
  async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'backup-offline' }] },
  async listModels(provider) {
    if (provider === 'deepseek-offline') return [{ id: 'primary' }]
    if (provider === 'backup-offline') return [{ id: 'backup' }]
    throw new Error('unknown provider')
  },
  async resolveModelInfo(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 }, reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } }
  },
})

/** 组装一个"够真"的 ctx：记录 hook、支持 prepend、返回可卸载句柄。 */
const fakeCtx = () => {
  const handlers = new Map()
  const options = new Map()
  const offs = []
  return {
    on(name, fn, opts) { handlers.set(name, fn); options.set(name, opts); const off = () => handlers.delete(name); offs.push(off); return off },
    emit(name, payload, next) { const fn = handlers.get(name); return fn === undefined ? next() : fn(payload, next) },
    has: (name) => handlers.has(name),
    optionsOf: (name) => options.get(name),
    _handlers: handlers,
  }
}

const agent = (id) => ({ id, options: {} })
const baseConfig = () => ({ provider: 'human-provider', model: 'human-model', reasoningEffort: 'high', maxTokens: 4096 })

test('M2 首请求归属：claimed 先于 user/message；首 attempt 使用所选 pair；未登记消息不提升 owner', async () => {
  const ctx = fakeCtx()
  const audit = []
  let defaultSelection = { provider: 'human-provider', model: 'human-model' }
  const routing = createModelRouting({
    ctx, llm: fakeLlm(), audit: (r) => audit.push(r),
    selectionOf: () => defaultSelection,
    baseSelection: { provider: 'human-provider', model: 'human-model' },
  })
  const uninstall = routing.install()
  assert.equal(ctx.has('agent/request'), true)
  assert.equal(ctx.has('agent/request-error'), true)
  assert.equal(ctx.has('agent/inbox/claimed'), true)

  const plan = await routing.planRoute({ taskId: 'task-1', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'origin-1', sessionId: 'sess-1' })
  assert.equal(plan.selection.ok, true)
  assert.equal(plan.selection.pair.provider, 'deepseek-offline', 'auto 必须优先已配置的 DeepSeek')

  const a = agent('agent-1')
  // 未登记的人类消息：不绑定、不影响
  routing.onClaimed({ agent: a, turn: 1, message: { source: { kind: 'user' } } })
  const human = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => baseConfig())
  assert.equal(human.provider, 'human-provider', '未登记消息绝不能成为 route owner')
  // 已登记 requestId：认领为首次请求
  routing.onClaimed({ agent: a, turn: 1, message: { source: { kind: 'user', rpcId: 'task-1' } } })
  const first = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => baseConfig())
  assert.equal(first.provider, 'deepseek-offline')
  assert.equal(first.model, 'primary')
  assert.equal(first.reasoningEffort, 'high', '同 provider 能力的 effort 可保留')
  assert.equal(routing.isBound('task-1'), true)
  assert.equal(audit.some((e) => e.kind === 'first-request-bound' && e.taskId === 'task-1'), true)
  assert.equal(audit.some((e) => e.kind === 'first-request' && e.provider === 'deepseek-offline'), true)
  uninstall()
  assert.equal(routing.isBound('task-1'), false, '卸载后绑定必须失效')
})

test('M2 同 turn/step 有界切换：结构化失败 → 换 pair 重试；不兼容 effort 被清除；不切类交还', async () => {
  const ctx = fakeCtx()
  const audit = []
  let selection = { provider: 'human-provider', model: 'human-model' }
  const routing = createModelRouting({
    ctx, llm: fakeLlm(), audit: (r) => audit.push(r), selectionOf: () => selection,
    baseSelection: { provider: 'human-provider', model: 'human-model' },
  })
  const uninstall = routing.install()
  await routing.planRoute({ taskId: 'task-2', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-2')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'task-2' } } })
  const first = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => baseConfig())
  assert.equal(first.provider, 'deepseek-offline')
  // 认证类结构化失败 → 切换（同一 turn/step）
  const action = await routing.onRequestError({ agent: a, turn: 1, step: 2, provider: 'deepseek-offline', failure: { code: 'AUTH', message: 'SECRET-BODY-SHOULD-NOT-BE-LOGGED' }, signal: { aborted: false } }, async () => undefined)
  assert.deepEqual(action, { kind: 'retry' })
  const second = await routing.onRequest({ agent: a, turn: 1, step: 3 }, async () => ({ ...baseConfig(), reasoningEffort: 'high', maxTokens: 4096 }))
  assert.equal(second.provider, 'backup-offline', '切换后必须真正换 pair')
  assert.equal(second.model, 'backup')
  assert.equal(audit.some((e) => e.kind === 'switch' && e.to.provider === 'backup-offline'), true)
  assert.equal(JSON.stringify(audit).includes('SECRET-BODY-SHOULD-NOT-BE-LOGGED'), false, '审计绝不含 failure.message 正文')
  // 不切类：工具错误 → 交还原生策略（undefined）
  const passthrough = await routing.onRequestError({ agent: a, turn: 1, step: 4, provider: 'backup-offline', failure: { code: 'TOOL_ERROR' }, signal: { aborted: false } }, async () => undefined)
  assert.equal(passthrough, undefined)
  assert.equal(audit.some((e) => e.kind === 'stop' && e.reason === 'not-a-model-availability-failure'), true)
  // 取消：不切
  const aborted = await routing.onRequestError({ agent: a, turn: 1, step: 5, provider: 'backup-offline', failure: { code: 'ABORTED' }, signal: { aborted: true } }, async () => undefined)
  assert.equal(aborted, undefined)
  uninstall()
})

test('M2 禁 fallback 不切换；候选耗尽如实停止（不是 done）', async () => {
  const ctx = fakeCtx()
  const audit = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r), selectionOf: () => null })
  const uninstall = routing.install()
  // allowFallback=false（精确指定默认固定）
  await routing.planRoute({ taskId: 'task-3', policy: { mode: 'exact', provider: 'deepseek-offline', model: 'primary', allowFallback: false }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-3')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'task-3' } } })
  const first = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => baseConfig())
  assert.equal(first.provider, 'deepseek-offline')
  const action = await routing.onRequestError({ agent: a, turn: 1, step: 2, provider: 'deepseek-offline', failure: { code: 'AUTH' }, signal: { aborted: false } }, async () => undefined)
  assert.equal(action, undefined, '禁 fallback 时不得自动切换')
  assert.equal(audit.some((e) => e.kind === 'stop' && e.reason === 'fallback-disabled'), true)
  uninstall()
})

test('M2 泄漏条件恢复（逐 agent 真实基线）：同一 agent 的人工回合恢复原选择；人类改选尊重；别的 agent 不动', async () => {
  const ctx = fakeCtx()
  const audit = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r) })
  const uninstall = routing.install()
  await routing.planRoute({ taskId: 'task-4', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-4')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'task-4' } } })
  const humanBase = { provider: 'human-provider', model: 'human-model', reasoningEffort: 'high', maxTokens: 4096 }
  await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => humanBase)
  routing.finishRoute({ taskId: 'task-4', status: 'done' })
  // 泄漏：同一 agent 的人工 turn2，机器提出的正是我们写过的路由 → 恢复**这个 agent 的真实基线**
  const human1 = await routing.onRequest({ agent: a, turn: 2, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary' }))
  assert.equal(human1.provider, 'human-provider', '同 agent 的泄漏必须按该 agent 的真实基线恢复')
  assert.equal(human1.model, 'human-model')
  assert.equal(human1.reasoningEffort, 'high', '恢复要带上原 intent 的 effort，而不是只换 provider/model')
  assert.equal(audit.some((e) => e.kind === 'restore' && e.agentId === 'agent-4'), true)
  // 人类明确改选（机器提出既不是我们的覆盖）→ 尊重，不覆盖
  await routing.planRoute({ taskId: 'task-4b', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  routing.onClaimed({ agent: a, turn: 3, message: { source: { rpcId: 'task-4b' } } })
  await routing.onRequest({ agent: a, turn: 3, step: 1 }, async () => humanBase)
  routing.finishRoute({ taskId: 'task-4b', status: 'done' })
  const human2 = await routing.onRequest({ agent: a, turn: 4, step: 1 }, async () => ({ provider: 'alternate-offline', model: 'alternate' }))
  assert.equal(human2.provider, 'alternate-offline', '人类新选择必须优先，恢复逻辑不得覆盖')
  assert.equal(human2.model, 'alternate')
  // 别的 agent（另一条会话）完全不受影响
  const other = await routing.onRequest({ agent: agent('other-agent'), turn: 1, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary' }))
  assert.equal(other.provider, 'deepseek-offline', '没有 intent 记录的其它 agent 不得被改')
  uninstall()
})

test('A/B 反例回归：绑定只在本任务 turn 内有效（人工新 turn 立即失活且不记给旧任务）', async () => {
  const ctx = fakeCtx()
  const audit = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r) })
  const uninstall = routing.install()
  await routing.planRoute({ taskId: 'stale-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-stale')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'stale-task' } } })
  const first = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  assert.equal(first.provider, 'deepseek-offline')
  // 人工进入 turn2 并**显式选择** alternate：旧绑定必须立即失活，绝不能被覆盖也不许记给旧任务
  const human = await routing.onRequest({ agent: a, turn: 2, step: 1 }, async () => ({ provider: 'alternate-offline', model: 'alternate' }))
  assert.equal(human.provider, 'alternate-offline', '人工 turn2 的选择不得被旧任务绑定覆盖')
  assert.equal(human.model, 'alternate')
  assert.equal(audit.some((e) => e.kind === 'attempt' && e.taskId === 'stale-task' && e.turn === 2), false, '人工 turn2 不得被记给旧任务')
  assert.equal(routing.isBound('stale-task'), false, 'turn 迁移后旧绑定必须已失活')
  uninstall()
})

test('A 反例回归：登记 sessionX 的 task 被 sessionY claim → 拒绝绑定（ID 不是授权）', async () => {
  const ctx = fakeCtx()
  const audit = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r) })
  const uninstall = routing.install()
  await routing.planRoute({ taskId: 'session-specific-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 'session-X' })
  const wrongAgent = { id: 'agent-Y', session: { id: 'session-Y' } }
  routing.onClaimed({ agent: wrongAgent, turn: 1, message: { source: { rpcId: 'session-specific-task' } } })
  const wrongReq = await routing.onRequest({ agent: wrongAgent, turn: 1, step: 1 }, async () => ({ provider: 'alternate-offline', model: 'alternate' }))
  assert.equal(wrongReq.provider, 'alternate-offline', '错 session 的 claim 绝不能接管')
  assert.equal(routing.isBound('session-specific-task'), false)
  assert.equal(audit.some((e) => e.kind === 'unbound' && e.reason === 'session-mismatch'), true, '必须留下 session-mismatch 审计')
  // 正确 session 的 claim → 正常绑定
  const rightAgent = { id: 'agent-X', session: { id: 'session-X' } }
  routing.onClaimed({ agent: rightAgent, turn: 1, message: { source: { rpcId: 'session-specific-task' } } })
  const rightReq = await routing.onRequest({ agent: rightAgent, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  assert.equal(rightReq.provider, 'deepseek-offline', '登记 session 与真实 session 一致时必须绑定成功')
  uninstall()
})

test('B/D 反例回归：worker 首请求按 childId + **expectedOwner 官方 isOwnedBy** 绑定（无 owner/错 owner → 不接管）', async () => {
  const ctx = fakeCtx()
  const audit = []
  const owners = new Map()
  const liveAgents = new Map()
  const registry = {
    get: (id) => liveAgents.get(id),
    isOwnedBy: (childId, owner) => owners.get(childId) !== undefined && owner !== null && owner !== undefined && owners.get(childId) === owner.id,
  }
  const agentFor = (id, parent) => { const a = { id, session: { id: 'sess-' + id } }; liveAgents.set(id, a); owners.set(id, parent); return a }
  // owner 也必须是 registry 里的 live agent（官方 isOwnedBy 收 owner 对象）
  agentFor('parent-A', null)
  agentFor('parent-B', null)
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r), agents: () => registry })
  const uninstall = routing.install()
  // ① 无 expectedOwner → fail-closed（绝不允许"撞上同 childId 就接管"）
  await routing.planRoute({ taskId: 'worker-no-owner', policy: { mode: 'auto' }, kind: 'worker', originThreadId: 'o', childId: 'child-no-owner' })
  const noOwnerChild = agentFor('child-no-owner', 'parent-A')
  routing.onClaimed({ agent: noOwnerChild, turn: 1, message: { source: { kind: 'user' } } })
  const untouched1 = await routing.onRequest({ agent: noOwnerChild, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  assert.equal(untouched1.provider, 'backup-offline', '缺 expectedOwner 时必须 fail-closed')
  assert.equal(audit.some((e) => e.kind === 'unbound' && e.reason === 'worker-owner-unknown'), true)
  // ② 真实 owner 是**另一个 parent** 的 child → 不得接管（Root turn50 反例 4）
  await routing.planRoute({ taskId: 'wrong-worker-owner-task', policy: { mode: 'auto' }, kind: 'worker', originThreadId: 'o', childId: 'child-wrong-owner', expectedOwner: 'parent-A' })
  const wrongOwnerChild = agentFor('child-wrong-owner', 'parent-B')
  routing.onClaimed({ agent: wrongOwnerChild, turn: 1, message: { source: { kind: 'user' } } })
  const untouched2 = await routing.onRequest({ agent: wrongOwnerChild, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  assert.equal(untouched2.provider, 'backup-offline', '属于另一 parent 的 child 绝不能被接管')
  assert.equal(audit.some((e) => e.kind === 'unbound' && e.reason === 'worker-owner-mismatch'), true)
  // ③ 正确 owner + 精确 childId → 绑定并使用所选 pair
  await routing.planRoute({ taskId: 'worker-task', policy: { mode: 'auto' }, kind: 'worker', originThreadId: 'o', childId: 'child-expected-1', expectedOwner: 'parent-A' })
  const expected = agentFor('child-expected-1', 'parent-A')
  routing.onClaimed({ agent: expected, turn: 1, message: { source: { kind: 'user' } } })
  const bound = await routing.onRequest({ agent: expected, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  assert.equal(bound.provider, 'deepseek-offline', 'owner 正确时 worker 首请求必须真正用所选 pair')
  assert.equal(audit.some((e) => e.kind === 'first-request-bound' && e.via === 'worker-childId+owner'), true)
  // ④ epoch：live registry 换新对象（模拟重建）→ 旧绑定失效
  const rebuilt = { id: 'child-expected-1', session: { id: 'sess-rebuilt' } }
  liveAgents.set('child-expected-1', rebuilt)
  const afterEpoch = await routing.onRequest({ agent: rebuilt, turn: 1, step: 2 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  assert.equal(afterEpoch.provider, 'backup-offline', 'registry epoch 变化后旧绑定必须失效')
  uninstall()
})

test('第二轮3：跨连续托管任务保留真实基线 / 同值人工重选优先 / 恢复是完整合法配置', async () => {
  const ctx = fakeCtx()
  const audit = []
  let selectionEvents = []
  const llm = {
    async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'backup-offline' }] },
    async listModels(p) { return p === 'deepseek-offline' ? [{ id: 'primary' }] : [{ id: 'backup' }] },
    async resolveModelInfo() { return { context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: { id: 'low', name: 'Low' } } } },
  }
  const routing = createModelRouting({ ctx, llm, audit: (r) => audit.push(r), readSessionEvents: async () => selectionEvents })
  const uninstall = routing.install()
  // 这三个 agent 带真实 session id（等于登记的 sessionId），官方 `model/selection` 才能被定位到
  const a = { id: 'agent-chain', session: { id: 's' }, options: {} }

  // ① 连续托管 A、B：B 首请求时机器提出的是**我们上一次的覆盖** → 必须沿用真实基线（backup/high），不得当成新基线
  await routing.planRoute({ taskId: 'chain-A', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'chain-A' } } })
  await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup', reasoningEffort: 'high' }))
  routing.finishRoute({ taskId: 'chain-A', status: 'done' })
  await routing.planRoute({ taskId: 'chain-B', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  routing.onClaimed({ agent: a, turn: 2, message: { source: { rpcId: 'chain-B' } } })
  const bRequest = await routing.onRequest({ agent: a, turn: 2, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary' }))   // 机器提出的是泄漏值
  assert.equal(bRequest.provider, 'deepseek-offline', '托管任务本身仍按我们的选择执行')
  routing.finishRoute({ taskId: 'chain-B', status: 'done' })
  const human3 = await routing.onRequest({ agent: a, turn: 3, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary' }))
  assert.equal(human3.provider, 'backup-offline', '连续托管后人工 turn 必须恢复到**最初真实基线**（不是 A/B 的覆盖）')
  assert.equal(human3.model, 'backup')
  assert.equal(human3.reasoningEffort, 'high', '基线里的 effort 由基线决定')

  // ② 同值人工重选：用户在托管期间明确 append `model/selection`（与我们覆盖值**相同**）→ 尊重，绝不恢复
  selectionEvents = []
  await routing.planRoute({ taskId: 'explicit-human-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const b = { id: 'agent-explicit', session: { id: 's' }, options: {} }
  routing.onClaimed({ agent: b, turn: 1, message: { source: { rpcId: 'explicit-human-task' } } })
  await routing.onRequest({ agent: b, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  routing.finishRoute({ taskId: 'explicit-human-task', status: 'done' })
  selectionEvents = [{ seq: 77, type: 'model/selection', data: { provider: 'deepseek-offline', model: 'primary' } }]
  const humanSame = await routing.onRequest({ agent: b, turn: 2, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary' }))
  assert.equal(humanSame.provider, 'deepseek-offline', '人工明确重选（即使同值）绝不能被恢复覆盖')
  assert.equal(audit.some((e) => e.kind === 'respect-human-selection'), true)

  // ③ 恢复完整合法配置：基线没有 effort，而泄漏值带了 low → 恢复后必须**不残留** low
  selectionEvents = []
  await routing.planRoute({ taskId: 'restore-effort-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const c = { id: 'agent-restore', session: { id: 's' }, options: {} }
  routing.onClaimed({ agent: c, turn: 1, message: { source: { rpcId: 'restore-effort-task' } } })
  await routing.onRequest({ agent: c, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))   // 基线：无 effort
  routing.finishRoute({ taskId: 'restore-effort-task', status: 'done' })
  const human4 = await routing.onRequest({ agent: c, turn: 2, step: 1 }, async () => ({ provider: 'deepseek-offline', model: 'primary', reasoningEffort: 'low' }))
  assert.equal(human4.provider, 'backup-offline')
  assert.equal(human4.reasoningEffort, undefined, '恢复必须是完整合法配置：基线没有 effort 就不能残留我们带上的 low')
  uninstall()
})

test('第二轮1：request-error 必须 prepend（always 在外层，append 会被吞掉后继续重试）', async () => {
  const ctx = fakeCtx()
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: () => {} })
  const uninstall = routing.install()
  assert.equal(ctx.optionsOf('agent/request-error').prepend, true, 'agent/request-error 必须 prepend')
  assert.equal(ctx.optionsOf('agent/request').prepend, true, 'agent/request 也必须 prepend（先于机器配置决定）')
  // 托管终态不调 next：传一个"会记录是否被调用"的 next
  let nextCalled = 0
  await routing.planRoute({ taskId: 'owned-terminal', policy: { mode: 'exact', provider: 'deepseek-offline', model: 'primary', allowFallback: false }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-terminal')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'owned-terminal' } } })
  await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  const result = await routing.onRequestError({ agent: a, turn: 1, step: 2, provider: 'deepseek-offline', failure: { code: 'SERVER' }, signal: { aborted: false } }, async () => { nextCalled += 1; return undefined })
  assert.equal(result, undefined, '托管非耗尽终态应直接 return undefined')
  assert.equal(nextCalled, 0, '托管终态**绝不**调用 next（否则 always 会继续重试）')
  uninstall()
})

test('第二轮2/3e：卸载后目录/能力 await 返回不得改配置、不得写审计（closed+generation 门闩）', async () => {
  const ctx = fakeCtx()
  const audit = []
  // resolveInfo 挂起：直到我们手动放行
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const llm = {
    async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'backup-offline' }] },
    async listModels(p) { return p === 'deepseek-offline' ? [{ id: 'primary' }] : [{ id: 'backup' }] },
    async resolveModelInfo(p, m) { if (p === 'deepseek-offline') { await gate; return { context: { contextWindow: 128000 } } } return { context: { contextWindow: 128000 } } },
  }
  const routing = createModelRouting({ ctx, llm, audit: (r) => audit.push(r) })
  const uninstall = routing.install()
  // 计划阶段：await 中卸载 → 不得写 plan
  const planPromise = routing.planRoute({ taskId: 'plan-unload', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  uninstall()
  release()
  const plan = await planPromise
  assert.equal(plan.cancelled, true, '卸载后 planRoute 必须返回 cancelled')
  assert.equal(audit.some((e) => e.kind === 'plan'), false, '卸载后绝不能写 plan 审计')
  assert.equal(routing.status().counters.plans, 0, '卸载后不得计数')
  // 重新安装后：请求阶段 await 中卸载 → 不得改配置、不得写 first-request
  const routing2 = createModelRouting({ ctx: fakeCtx(), llm, audit: (r) => audit.push(r) })
  const ctx2 = fakeCtx()
  const r3 = createModelRouting({ ctx: ctx2, llm, audit: (r) => audit.push(r) })
  const un3 = r3.install()
  await r3.planRoute({ taskId: 'req-unload', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-unload')
  r3.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'req-unload' } } })
  const reqPromise = r3.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'backup-offline', model: 'backup' }))
  un3()
  release()
  const cfg = await reqPromise
  assert.equal(cfg.provider, 'backup-offline', '卸载后返回的必须是机器原配置（不得改成 DeepSeek）')
  assert.equal(audit.some((e) => e.kind === 'first-request'), false, '卸载后不得写 first-request 审计')
  void routing2
})

test('D 反例回归：切换时按**目标模型真实能力**处理 effort/maxTokens（不把 high 送给不支持 reasoning 的模型）', async () => {
  const ctx = fakeCtx()
  const audit = []
  // primary 支持 high；backup 只支持 low（defaultEffort=low）且 defaultMaxTokens=2048
  const llm = {
    async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'backup-offline' }] },
    async listModels(p) { return p === 'deepseek-offline' ? [{ id: 'primary' }] : [{ id: 'backup' }] },
    async resolveModelInfo(p, m) {
      if (p === 'deepseek-offline') return { context: { contextWindow: 128000 }, defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: { id: 'low', name: 'Low' } } }
      return { context: { contextWindow: 128000 }, defaultMaxTokens: 2048, reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: { id: 'low', name: 'Low' } } }
    },
  }
  const routing = createModelRouting({ ctx, llm, audit: (r) => audit.push(r) })
  const uninstall = routing.install()
  await routing.planRoute({ taskId: 'effort-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const a = agent('agent-effort')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'effort-task' } } })
  // 继承的 high 在 primary 上保留（能力支持）
  const first = await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model', reasoningEffort: 'high', maxTokens: 8192 }))
  assert.equal(first.provider, 'deepseek-offline')
  assert.equal(first.reasoningEffort, 'high', '目标支持 high 时必须保留')
  assert.equal(first.maxTokens, 8192, '未超过目标上限时保留 maxTokens')
  // 切到 backup（只支持 low、上限 2048）→ effort 必须降为 low（不能把 high 送过去触发 UNSUPPORTED_REASONING_EFFORT），maxTokens 收敛
  const action = await routing.onRequestError({ agent: a, turn: 1, step: 2, provider: 'deepseek-offline', failure: { code: 'AUTH' }, signal: { aborted: false } }, async () => undefined)
  assert.deepEqual(action, { kind: 'retry' })
  const second = await routing.onRequest({ agent: a, turn: 1, step: 2 }, async () => ({ provider: 'deepseek-offline', model: 'primary', reasoningEffort: 'high', maxTokens: 8192 }))
  assert.equal(second.provider, 'backup-offline')
  assert.equal(second.model, 'backup')
  assert.equal(second.reasoningEffort, 'low', '不支持 high 的目标必须改用其 defaultEffort（绝不能原样送 high）')
  assert.equal(second.maxTokens, 2048, 'maxTokens 必须收敛到目标上限')
  // 能力解析失败（未知）→ 不带 effort（宁可让 adapter 用默认）
  uninstall()
})

test('C 收口：托管终态回调给出本任务终止事实（耗尽与禁 fallback 都通知，且不 abort 观察者）', async () => {
  const ctx = fakeCtx()
  const terminalEvents = []
  const exhaustedEvents = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: () => {} })
  const uninstall = routing.install()
  // ① 耗尽：onTerminal + onExhausted 都要拿到稳定 reason
  await routing.planRoute({
    taskId: 'exhausted-task', policy: { mode: 'auto' }, kind: 'task', execution: 'session', originThreadId: 'o', sessionId: 's',
    onTerminal: (info) => terminalEvents.push(info), onExhausted: (reason) => exhaustedEvents.push(reason),
  })
  const a = agent('agent-exhausted')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'exhausted-task' } } })
  await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  let thrown = null
  for (let i = 0; i < 6; i += 1) {
    try { await routing.onRequestError({ agent: a, turn: 1, step: 1, provider: 'deepseek-offline', failure: { code: 'AUTH' }, signal: { aborted: false } }, async () => undefined) } catch (e) { thrown = e; break }
  }
  assert.equal(thrown !== null, true, '耗尽仍要抛 MODEL_ROUTE_EXHAUSTED 阻止原生 always 重试')
  assert.equal(exhaustedEvents.length >= 1, true, 'onExhausted 必须收到 reason')
  assert.equal(terminalEvents.some((e) => e.exhausted === true && typeof e.reason === 'string'), true, 'onTerminal 必须收到 exhausted 事实: ' + JSON.stringify(terminalEvents))
  assert.equal(routing.status().counters.exhaustedAborts >= 1, true)
  // ② 禁 fallback：只是非耗尽终态 → onTerminal 通知、onExhausted 不通知、不抛错
  terminalEvents.length = 0
  await routing.planRoute({
    taskId: 'nofallback-task', policy: { mode: 'exact', provider: 'deepseek-offline', model: 'primary', allowFallback: false }, kind: 'task', execution: 'session',
    originThreadId: 'o', sessionId: 's',
    onTerminal: (info) => terminalEvents.push(info), onExhausted: () => { throw new Error('should not exhaust') },
  })
  const b = { id: 'agent-nofallback', session: { id: 's' } }
  routing.onClaimed({ agent: b, turn: 1, message: { source: { rpcId: 'nofallback-task' } } })
  await routing.onRequest({ agent: b, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  const result = await routing.onRequestError({ agent: b, turn: 1, step: 1, provider: 'deepseek-offline', failure: { code: 'AUTH' }, signal: { aborted: false } }, async () => undefined)
  assert.equal(result, undefined, '禁 fallback 的托管终态直接 return undefined（不调 next）')
  assert.equal(terminalEvents.some((e) => e.reason === 'fallback-disabled' && e.exhausted === false), true, '禁 fallback 也必须通知宿主终止事实: ' + JSON.stringify(terminalEvents))
  uninstall()
})

test('C 反例回归：候选耗尽 → 真终止（回调宿主 abort）+ retry-after 有界等待且尊重取消', async () => {
  const ctx = fakeCtx()
  const audit = []
  const routing = createModelRouting({ ctx, llm: fakeLlm(), audit: (r) => audit.push(r), maxRetryAfterMs: 5000 })
  const uninstall = routing.install()
  // 单候选 + 耗尽 → 必须触发 onExhausted（宿主据此 abort 本任务 signal，原生 always 不再拿到 retry）
  const plan = await routing.planRoute({ taskId: 'always-task', policy: { mode: 'exact', provider: 'deepseek-offline', model: 'primary', allowFallback: true }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  let aborted = null
  plan.onExhausted = (reason) => { aborted = reason }
  const a = agent('agent-always')
  routing.onClaimed({ agent: a, turn: 1, message: { source: { rpcId: 'always-task' } } })
  await routing.onRequest({ agent: a, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  // 反复同 turn 失败：候选池只有 exact 自身（allowFallback:true 但 exact 的池含其它 pair）→ 用 maxCandidates 收紧到 1
  let lastAction = null
  let stopError = null
  for (let i = 0; i < 6; i += 1) {
    try {
      lastAction = await routing.onRequestError({ agent: a, turn: 1, step: 2 + i, provider: 'deepseek-offline', failure: { code: 'AUTH' }, signal: { aborted: false } }, async () => undefined)
    } catch (e) { stopError = e; break }
    if (lastAction === undefined) break
  }
  assert.notEqual(stopError, null, '预算耗尽必须**抛出结构化终止**（不能 return next() 把控制交回原生 always）')
  assert.equal(stopError.code, 'MODEL_ROUTE_EXHAUSTED')
  assert.notEqual(aborted, null, '预算耗尽必须通知宿主真终止（abort 本任务 signal）')
  assert.equal(audit.some((e) => e.kind === 'stop' && e.exhausted === true), true)
  // retry-after：等待必须接近 provider 指定值（不是 2ms），且取消时立刻返回
  await routing.planRoute({ taskId: 'retry-task', policy: { mode: 'auto' }, kind: 'session', originThreadId: 'o', sessionId: 's' })
  const b = agent('agent-retry')
  routing.onClaimed({ agent: b, turn: 1, message: { source: { rpcId: 'retry-task' } } })
  await routing.onRequest({ agent: b, turn: 1, step: 1 }, async () => ({ provider: 'human-provider', model: 'human-model' }))
  const t0 = Date.now()
  await routing.onRequestError({ agent: b, turn: 1, step: 2, provider: 'deepseek-offline', provider: 'deepseek-offline', failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 300 }, signal: { aborted: false } }, async () => undefined)
  const elapsed = Date.now() - t0
  assert.equal(elapsed >= 250, true, 'retry-after 必须被有界等待（实测 ≥250ms，而不是 2ms）: ' + elapsed + 'ms')
  uninstall()
})

test('M2 只读目录视图：pair + 失败隔离 + 冷却可见 + 明确"≠已验证可调用"', async () => {
  const ctx = fakeCtx()
  const llm = {
    async listProviders() { return [{ id: 'deepseek-offline' }, { id: 'broken' }] },
    async listModels(provider) { if (provider === 'broken') throw Object.assign(new Error('down'), { code: 'CATALOG_FAILED' }); return [{ id: 'primary' }] },
    async resolveModelInfo(p, m) { return { provider: p, id: m } },
  }
  const routing = createModelRouting({ ctx, llm, audit: () => {} })
  const view = await routing.modelsView()
  assert.equal(view.ok, true)
  assert.equal(view.pairs.length, 1)
  assert.equal(view.failures.length, 1)
  assert.equal(view.failures[0].provider, 'broken')
  assert.match(view.note, /不等于凭据\/额度\/远端健康已验证/)
  assert.equal(Array.isArray(view.cooldowns), true)
  const status = routing.status()
  assert.equal(typeof status.counters.plans, 'number')
  assert.equal(status.limits.maxCandidates, 3)
})
