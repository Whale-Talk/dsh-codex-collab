/**
 * 动态模型路由 M1 策略矩阵回归（纯逻辑，无 SDK/无网络）。
 * 覆盖 Root canonical 验收矩阵里可离线判定的部分：
 *  - 目录：provider 失败隔离、失败不永久缓存、pair 身份（跨 provider 同名不合并）、去重/有界；
 *  - 选择：DeepSeek 偏好、精确 pair、同名歧义拒绝、模态/上下文/effort 不兼容拒绝、能力未知如实标注、稳定回退顺序、inherit；
 *  - 分类：可切 / 先重试后切 / 绝不切 / HTTP404 只表示路由不可用 / 未知 code 不切；
 *  - 有界：每 pair 次数、候选上限、不重复选已失败、冷却与 retry-after、总时限、abort。
 * 跑法: node test/model-routing.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createModelCatalog, selectRoute, classifyFailure, createRouteSession,
  DEFAULT_ROUTE_LIMITS, pairOf,
} from '../harness/model-routing.mjs'

const fakeLlm = (spec) => ({
  async listProviders() {
    if (spec.providersThrows === true) throw new Error('providers down')
    return Object.keys(spec.providers).map((id) => ({ id, name: id }))
  },
  async listModels(provider) {
    const entry = spec.providers[provider]
    if (entry === undefined) throw new Error('unknown provider')
    if (entry.throws === true) { const e = new Error('catalog down'); e.code = 'CATALOG_FAILED'; throw e }
    return entry.models
  },
  async resolveModelInfo(provider, model) {
    const entry = spec.providers[provider]
    if (entry !== undefined && entry.infoThrows === true) { const e = new Error('info down'); e.code = 'RESOLVE_FAILED'; throw e }
    const info = entry !== undefined && entry.infos !== undefined ? entry.infos[model] : undefined
    if (info === undefined) return { provider, id: model, name: model }
    return { provider, id: model, name: model, ...info }
  },
})

test('目录：provider 失败隔离 + 失败不永久缓存 + pair 身份与去重', async () => {
  const spec = {
    providers: {
      'deepseek-off': { models: [{ id: 'chat', name: 'Chat' }, { id: 'chat', name: 'dup' }, { id: 'reasoner' }] },
      'broken': { throws: true },
      'backup': { models: [{ id: 'chat' }] },
    },
  }
  let clock = 1000
  const catalog = createModelCatalog({ llm: fakeLlm(spec), now: () => clock, ttlMs: 1000, failureTtlMs: 500 })
  const first = await catalog.snapshot()
  assert.equal(first.pairs.length, 3, '同 provider 重复 id 只留一条: ' + JSON.stringify(first.pairs))
  assert.deepEqual(first.pairs.map((p) => p.provider + '/' + p.model), ['deepseek-off/chat', 'deepseek-off/reasoner', 'backup/chat'])
  assert.equal(first.failures.length, 1)
  assert.equal(first.failures[0].provider, 'broken', '失败必须只影响该 provider')
  // 缓存内不重复枚举
  const cached = await catalog.snapshot()
  assert.equal(cached.servedFromCache, true)
  // 失败 TTL + 快照 TTL 过后重新尝试该 provider（**不永久缓存 null/失败**）
  clock += 1200
  spec.providers.broken = { models: [{ id: 'fixed' }] }
  const retried = await catalog.snapshot()
  assert.equal(retried.failures.some((f) => f.provider === 'broken'), false, '失败到期后必须重试并恢复')
  assert.equal(retried.pairs.some((p) => p.provider === 'broken' && p.model === 'fixed'), true)
  // 显式失效也必须立刻重取（拓扑变更事件路径）
  clock += 10
  catalog.invalidate()
  const forced = await catalog.snapshot()
  assert.equal(forced.servedFromCache, false, 'invalidate() 后必须重新枚举')
  // TTL 过期后整体重取
  clock += 2000
  const fresh = await catalog.snapshot()
  assert.equal(fresh.servedFromCache, false)
  assert.equal(fresh.stale, false)
})

test('目录不可用：不缓存成空目录结论（下次仍尝试），并如实标 unavailable', async () => {
  let calls = 0
  const llm = { async listProviders() { calls += 1; if (calls === 1) throw new Error('down'); return [{ id: 'p' }] }, async listModels() { return [{ id: 'm' }] }, async resolveModelInfo() { return {} } }
  const catalog = createModelCatalog({ llm, ttlMs: 1000 })
  const a = await catalog.snapshot()
  assert.equal(a.unavailable, true)
  assert.equal(a.pairs.length, 0)
  const b = await catalog.snapshot()
  assert.equal(calls, 2, '目录整体失败不得缓存：下次调用必须重新尝试')
  assert.equal(b.pairs.length, 1)
})

test('选择：DeepSeek 偏好、稳定回退、精确 pair、同名歧义拒绝、不兼容过滤、能力未知如实标注', async () => {
  const spec = {
    providers: {
      'other': { models: [{ id: 'big-pro', name: 'Big Pro' }], infos: { 'big-pro': { context: { contextWindow: 128000 }, reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } } } },
      'deepseek-x': { models: [{ id: 'chat-flash' }, { id: 'reasoner-pro' }], infos: { 'chat-flash': { context: { contextWindow: 64000 }, reasoning: { efforts: ['low', 'high'] } }, 'reasoner-pro': { context: { contextWindow: 256000 }, reasoning: { efforts: ['high'] } } } },
    },
  }
  const catalog = createModelCatalog({ llm: fakeLlm(spec) })
  const auto = await selectRoute({ catalog, request: { mode: 'auto', taskKind: 'code' }, resolveInfo: catalog.resolveInfo })
  assert.equal(auto.ok, true)
  assert.equal(auto.pair.provider, 'deepseek-x', 'DeepSeek 优先（偏好，不是质量结论）')
  assert.equal(auto.reason, 'deepseek-preferred')
  assert.equal(auto.capabilityKnown, true)
  assert.equal(Array.isArray(auto.alternatives), true)

  // pro 偏好按可解释名称提示
  const pro = await selectRoute({ catalog, request: { mode: 'pro', taskKind: 'review' }, resolveInfo: catalog.resolveInfo })
  assert.equal(pro.pair.provider, 'deepseek-x')

  // 精确 pair
  const exact = await selectRoute({ catalog, request: { mode: 'exact', provider: 'other', model: 'big-pro' }, resolveInfo: catalog.resolveInfo })
  assert.equal(exact.ok, true)
  assert.equal(exact.pair.provider, 'other')
  assert.equal(exact.pair.model, 'big-pro')
  // 精确 pair 不在目录 → 明确拒绝 + 给同名候选
  const missingPair = await selectRoute({ catalog, request: { mode: 'exact', provider: 'nope', model: 'big-pro' }, resolveInfo: catalog.resolveInfo })
  assert.equal(missingPair.ok, false)
  assert.equal(missingPair.reason, 'exact-pair-not-in-catalog')
  assert.equal(missingPair.candidates.length, 1)

  // 同名跨 provider：不给 provider → 拒绝并列出候选（不静默选错）
  const dupSpec = { providers: { 'p1': { models: [{ id: 'same' }] }, 'p2': { models: [{ id: 'same' }] } } }
  const dupCatalog = createModelCatalog({ llm: fakeLlm(dupSpec) })
  const ambiguous = await selectRoute({ catalog: dupCatalog, request: { mode: 'exact', model: 'same' }, resolveInfo: dupCatalog.resolveInfo })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, 'model-ambiguous-across-providers')
  assert.equal(ambiguous.candidates.length, 2, '两个 provider 的同名模型必须都列为候选')

  // 模态不兼容：要求图片输入，候选未知/不支持 → 拒绝而不是静默降级
  const modality = await selectRoute({ catalog, request: { mode: 'auto', needs: { inputModalities: ['image'], requireKnownCapabilities: true } }, resolveInfo: catalog.resolveInfo })
  assert.equal(modality.ok, false)
  assert.equal(modality.reason, 'no-compatible-candidate')

  // 上下文不足 → 拒绝（不丢历史凑兼容）
  const context = await selectRoute({ catalog, request: { mode: 'auto', needs: { contextWindow: 512000 } }, resolveInfo: catalog.resolveInfo })
  assert.equal(context.ok, false)
  assert.equal(context.rejected.some((r) => r.rejected === 'context-too-small'), true)

  // effort 不支持 → 拒绝（不沿用不兼容 effort）
  const effort = await selectRoute({ catalog, request: { mode: 'auto', needs: { effort: 'medium' } }, resolveInfo: catalog.resolveInfo })
  assert.equal(effort.ok, false)
  assert.equal(effort.rejected.every((r) => r.rejected === 'effort-unsupported'), true)
  // 支持的 effort 通过
  const effortOk = await selectRoute({ catalog, request: { mode: 'auto', needs: { effort: 'high' } }, resolveInfo: catalog.resolveInfo })
  assert.equal(effortOk.ok, true)

  // resolveInfo 失败 → 能力未知，如实标注（不当"支持"）
  const infoFail = createModelCatalog({ llm: fakeLlm({ providers: { 'q': { models: [{ id: 'm' }], infoThrows: true } } }) })
  const unknown = await selectRoute({ catalog: infoFail, request: { mode: 'auto' }, resolveInfo: infoFail.resolveInfo })
  assert.equal(unknown.ok, true, '能力未知不等于不能用（如实标注）')
  assert.equal(unknown.capabilityKnown, false)

  // inherit：保留"继承当前选择"的兼容意图
  const inherit = await selectRoute({ catalog, request: { mode: 'inherit' }, resolveInfo: catalog.resolveInfo })
  assert.equal(inherit.ok, true)
  assert.equal(inherit.inherit, true)
})

test('分类：稳定 code 决定可切/先重试后切/绝不切；HTTP404 只表示路由不可用；未知 code 不切', () => {
  assert.equal(classifyFailure({ code: 'AUTH' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'MISSING_CREDENTIAL' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'QUOTA' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'UNKNOWN_MODEL' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 1200 }).action, 'retry-then-switch')
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 1200 }).retryAfterMs, 1200)
  assert.equal(classifyFailure({ code: 'SERVER' }).action, 'retry-then-switch')
  assert.equal(classifyFailure({ code: 'ABORTED' }).action, 'never')
  assert.equal(classifyFailure({ code: 'SAFETY' }).action, 'never')
  assert.equal(classifyFailure({ code: 'TOOL_ERROR' }).action, 'never')
  assert.equal(classifyFailure({ code: 'APPROVAL_DENIED' }).action, 'never')
  assert.equal(classifyFailure({ code: 'INVALID_REQUEST' }).action, 'never')
  assert.equal(classifyFailure({ code: 'SOMETHING_NEW' }).action, 'never', '未知 code 不得当供应商故障无限切')
  assert.equal(classifyFailure({ code: 'HTTP_404' }).action, 'switch')
  assert.equal(classifyFailure({ code: 'HTTP_404' }).reason, 'route-unavailable', '404 不能断言模型下架')
  assert.equal(classifyFailure({ code: 'HTTP_400' }).action, 'never')
  assert.equal(classifyFailure({ status: 503 }).action, 'retry-then-switch')
  assert.equal(classifyFailure({ status: 402 }).action, 'switch')
  assert.equal(classifyFailure({ message: 'boom' }).action, 'never', '没有结构化 code/status 就不切')
})

test('E 反例回归：官方对象形 efforts / 已知不可解析排除 / 自定义 provider 下的 DeepSeek 偏好 / exact 备选池 / 目录挂死有界', async () => {
  // 1) 真实 SDK 的 efforts 是 [{id,name}]：必须解析出 id，而不是判成空数组把支持 high 的模型误拒
  const objEffort = createModelCatalog({
    llm: {
      async listProviders() { return [{ id: 'deepseek-configured' }] },
      async listModels() { return [{ id: 'primary' }] },
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: { id: 'low', name: 'Low' } }, context: { contextWindow: 128000 }, defaultMaxTokens: 4096, inputModalities: ['text'] } },
    },
  })
  const eff = await selectRoute({ catalog: objEffort, request: { mode: 'auto', needs: { effort: 'high' } }, resolveInfo: objEffort.resolveInfo })
  assert.equal(eff.ok, true, '对象形 efforts 必须被正确解析（high 受支持）: ' + JSON.stringify(eff))
  const cap = (await objEffort.resolveInfo('deepseek-configured', 'primary')).capability
  assert.deepEqual(cap.efforts, ['low', 'high'])
  assert.equal(cap.defaultEffort, 'low')

  // 2) 明确 UNKNOWN_MODEL（已证不可解析）必须**排除**候选，而不是当 capability-unknown 首选
  const stale = createModelCatalog({
    llm: {
      async listProviders() { return [{ id: 'deepseek-stale' }, { id: 'backup-configured' }] },
      async listModels(p) { return p === 'deepseek-stale' ? [{ id: 'removed' }] : [{ id: 'valid' }] },
      async resolveModelInfo(p, m) {
        if (p === 'deepseek-stale') { const e = new Error('unknown model'); e.code = 'UNKNOWN_MODEL'; throw e }
        return { reasoning: { efforts: [{ id: 'high', name: 'High' }] }, context: { contextWindow: 128000 } }
      },
    },
  })
  const recovered = await selectRoute({ catalog: stale, request: { mode: 'auto' }, resolveInfo: stale.resolveInfo })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.pair.provider, 'backup-configured', '已知不可用的 DeepSeek 必须被排除，改选可用候选: ' + JSON.stringify(recovered.pair))
  // 全部候选都已知不可解析时 → 如实拒绝，并标出 capability-unresolvable（不是"未知能力随便选"）
  const allStale = createModelCatalog({
    llm: {
      async listProviders() { return [{ id: 'deepseek-stale' }] },
      async listModels() { return [{ id: 'removed' }] },
      async resolveModelInfo() { const e = new Error('unknown model'); e.code = 'UNKNOWN_MODEL'; throw e },
    },
  })
  const none = await selectRoute({ catalog: allStale, request: { mode: 'auto' }, resolveInfo: allStale.resolveInfo })
  assert.equal(none.ok, false)
  assert.equal(none.rejected.some((r) => String(r.rejected).startsWith('capability-unresolvable')), true, '必须区分"已知不可用"与"未知能力": ' + JSON.stringify(none.rejected))

  // 3) 自定义 provider 下的 DeepSeek 模型也要得到偏好（不能只看 provider 字符串）
  const custom = createModelCatalog({
    llm: {
      async listProviders() { return [{ id: 'first-custom' }, { id: 'second-custom' }] },
      async listModels(p) { return p === 'first-custom' ? [{ id: 'other-model', name: 'Other Model' }] : [{ id: 'deepseek-custom-flash', name: 'DeepSeek Custom Flash' }] },
      async resolveModelInfo() { return { context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'low', name: 'Low' }] } } },
    },
  })
  const customPick = await selectRoute({ catalog: custom, request: { mode: 'auto' }, resolveInfo: custom.resolveInfo })
  assert.equal(customPick.pair.model, 'deepseek-custom-flash', 'DeepSeek 模型名应获得偏好: ' + JSON.stringify(customPick.pair))
  assert.equal(customPick.reasons.includes('deepseek-preferred'), true)

  // 4) exact + allowFallback:true 必须给出**非空备选池**（否则显式降级形同虚设）
  const poolCatalog = createModelCatalog({
    llm: {
      async listProviders() { return [{ id: 'deepseek-configured' }, { id: 'backup-configured' }] },
      async listModels(p) { return p === 'deepseek-configured' ? [{ id: 'primary' }] : [{ id: 'valid' }] },
      async resolveModelInfo() { return { context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }] } } },
    },
  })
  const exactPool = await selectRoute({ catalog: poolCatalog, request: { mode: 'exact', provider: 'deepseek-configured', model: 'primary', allowFallback: true }, resolveInfo: poolCatalog.resolveInfo })
  assert.equal(exactPool.ok, true)
  assert.equal(Array.isArray(exactPool.alternatives) && exactPool.alternatives.length > 0, true, 'exact+modelFallback:true 必须有备选池: ' + JSON.stringify(exactPool.alternatives))
  const exactFixed = await selectRoute({ catalog: poolCatalog, request: { mode: 'exact', provider: 'deepseek-configured', model: 'primary', allowFallback: false }, resolveInfo: poolCatalog.resolveInfo })
  assert.equal(exactFixed.alternatives.length, 0, '显式关闭 fallback 时空池（固定）')

  // 5) 首 provider 目录挂死不返回 → 仍有界返回，且其它 provider 的候选可用
  const started = Date.now()
  const stalled = createModelCatalog({
    providerTimeoutMs: 120,
    llm: {
      async listProviders() { return [{ id: 'stalled-provider' }, { id: 'healthy-provider' }] },
      async listModels(p) { if (p === 'stalled-provider') return new Promise(() => {}); return [{ id: 'ok' }] },
      async resolveModelInfo() { return { context: { contextWindow: 128000 } } },
    },
  })
  const snap = await stalled.snapshot()
  const elapsed = Date.now() - started
  assert.equal(elapsed < 2000, true, '目录发现必须有界（不能挂住整次 snapshot）: ' + elapsed + 'ms')
  assert.equal(snap.pairs.some((p) => p.provider === 'healthy-provider'), true, '挂死的 provider 不得拖住其它候选')
  assert.equal(snap.failures.some((f) => f.provider === 'stalled-provider'), true)
})

test('恢复预算：健康时长不计入、单 pair/总恢复预算真实截止、retry-after 计入、恢复成功后重置', () => {
  const A = pairOf('p', 'a')
  const B = pairOf('p', 'b')
  // ① 长健康后首次故障仍能切换（旧实现按"建任务年龄"算 totalTimeout → 第一故障就 total-time-limit）
  let healthy = 1_000_000
  const late = createRouteSession({ initial: A, alternatives: [B], now: () => healthy })
  late.recordAttempt(A, { turn: 1, step: 1 })
  healthy += DEFAULT_ROUTE_LIMITS.totalTimeoutMs + 1
  const lateDecision = late.onFailure({ code: 'AUTH', status: 401 })
  assert.equal(lateDecision.action, 'retry', '长健康后的首次故障必须仍能切换')
  assert.equal(lateDecision.pair.key, B.key)
  assert.equal(lateDecision.switched, true)

  // ② 单 pair 恢复时限真实影响决策：同一 pair 在恢复 episode 里超过 perPairTimeoutMs → 不再重试它，改切换
  let tick = 0
  const pp = createRouteSession({ initial: A, alternatives: [B], now: () => tick, limits: { maxAttemptsPerPair: 5, perPairTimeoutMs: 10, totalTimeoutMs: 1000 } })
  pp.recordAttempt(A, { turn: 1, step: 1 })
  const f1 = pp.onFailure({ code: 'SERVER' })
  assert.equal(f1.action, 'retry')
  assert.equal(f1.pair.key, A.key, '时限未到前允许同 pair 有界重试')
  tick = 20
  pp.recordAttempt(A, { turn: 1, step: 1 })
  const f2 = pp.onFailure({ code: 'SERVER' })
  assert.equal(f2.action, 'retry')
  assert.equal(f2.pair.key, B.key, 'per-pair 恢复时限到 → 必须切换而不是继续重试原 pair')
  assert.equal(f2.reason, 'switch:per-pair-time-limit')

  // ③ retry-after 等待计入恢复预算，且不因每次 retry 重置（不会无限）
  let t = 0
  const rb = createRouteSession({ initial: A, alternatives: [B], now: () => t, limits: { totalTimeoutMs: 1000, maxAttemptsPerPair: 5, perPairTimeoutMs: 5000 } })
  rb.recordAttempt(A, { turn: 1, step: 1 })
  rb.onFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 900 })   // episode 从 t=0 开始
  t = 900
  rb.recordAttempt(A, { turn: 1, step: 1 })
  rb.onFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 900 })   // t=900 < 1000 → 再重试
  t = 1800
  rb.recordAttempt(A, { turn: 1, step: 1 })
  const rb3 = rb.onFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 900 })
  assert.equal(rb3.action, 'stop', 'retry-after 等待必须计入总恢复预算（不能被每次 retry 重置）')
  assert.equal(rb3.reason, 'total-time-limit')

  // ④ 一次恢复成功（下一 step 的 attempt 前没有失败）后再长时间健康 → 新 episode，不提前耗光恢复权
  let clock2 = 0
  const reset = createRouteSession({ initial: A, alternatives: [B, pairOf('p', 'c')], now: () => clock2, limits: { totalTimeoutMs: 1000, maxAttemptsPerPair: 1 } })
  reset.recordAttempt(A, { turn: 1, step: 1 })
  reset.onFailure({ code: 'AUTH' })                                  // episode 开启 → 切到 B
  clock2 = 50
  reset.recordAttempt(B, { turn: 1, step: 2 })                       // 健康推进（step 前进且无失败）→ episode 关闭
  const afterRecovery = reset.summary()
  assert.equal(afterRecovery.episodeOpen, false, '成功推进后恢复 episode 必须关闭')
  clock2 += DEFAULT_ROUTE_LIMITS.totalTimeoutMs + 1                  // 再长时间健康
  const nextDecision = reset.onFailure({ code: 'AUTH' })
  assert.equal(nextDecision.action, 'retry', '恢复成功后的长时间健康不得提前耗光下一次恢复权')
  assert.equal(nextDecision.pair.key, pairOf('p', 'c').key)
})

test('有界切换：每 pair 次数、候选上限、不重复选、冷却/retry-after、总时限、abort', () => {
  const A = pairOf('p', 'a')
  const B = pairOf('p', 'b')
  const C = pairOf('p', 'c')
  const D = pairOf('p', 'd')
  let clock = 10_000
  const cooldowns = new Map()
  const session = createRouteSession({
    initial: A, alternatives: [B, C, D], cooldowns, now: () => clock, limits: { maxCandidates: 3, maxAttemptsPerPair: 2, totalTimeoutMs: 1000, cooldownMs: 100 },
  })
  session.recordAttempt(A)
  // 限流：先在同 pair 有界重试（上限 2 次 = 已用 1 + 再 1）
  const r1 = session.onFailure({ code: 'SERVER' })
  assert.equal(r1.action, 'retry')
  assert.equal(r1.pair.key, A.key, '同 pair 有界重试优先')
  session.recordAttempt(A)
  const r2 = session.onFailure({ code: 'SERVER' })
  assert.equal(r2.action, 'retry')
  assert.equal(r2.pair.key, B.key, '重试次数用尽后切换')
  assert.equal(r2.switched, true)
  session.recordAttempt(B)
  // 认证类直接切
  const r3 = session.onFailure({ code: 'AUTH' })
  assert.equal(r3.pair.key, C.key)
  session.recordAttempt(C)
  // 候选上限 3（A/B/C 已用）→ 不再切
  const r4 = session.onFailure({ code: 'AUTH' })
  assert.equal(r4.action, 'stop')
  assert.equal(r4.reason, 'candidate-limit')
  assert.equal(r4.exhausted, true)
  // 不重复选已失败候选
  const s2 = createRouteSession({ initial: A, alternatives: [B, A, B], now: () => clock })
  s2.recordAttempt(A)
  const pick = s2.onFailure({ code: 'AUTH' })
  assert.equal(pick.pair.key, B.key)
  s2.recordAttempt(B)
  const none = s2.onFailure({ code: 'AUTH' })
  assert.equal(none.action, 'stop')
  assert.equal(none.reason, 'candidates-exhausted', '不得绕圈重选 A/B')
  // 冷却：A 失败后进冷却，alternatives 里再次出现 A 也不选
  const cool = new Map()
  const s3 = createRouteSession({ initial: A, alternatives: [A, B], cooldowns: cool, now: () => clock, limits: { cooldownMs: 5000 } })
  s3.recordAttempt(A)
  const cooled = s3.onFailure({ code: 'AUTH' })
  assert.equal(cooled.pair.key, B.key, '冷却中的 pair 不得被再次选中')
  assert.equal(cool.get(A.key) !== undefined, true, '失败 pair 进入有界冷却')
  // retry-after 被尊重（冷却用 providerRetryAfterMs）
  const cool2 = new Map()
  const s4 = createRouteSession({ initial: A, alternatives: [B], cooldowns: cool2, now: () => clock, limits: { maxAttemptsPerPair: 1, cooldownMs: 100 } })
  s4.recordAttempt(A)
  s4.onFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 7000 })
  assert.equal(cool2.get(A.key), clock + 7000, 'retry-after 必须被尊重')
  // 总时限（**恢复 episode** 语义：从第一次故障开始计时，健康运行时长不计入）
  const s5 = createRouteSession({ initial: A, alternatives: [B, C, D], now: () => clock, limits: { totalTimeoutMs: 100, maxCandidates: 3, maxAttemptsPerPair: 1 } })
  s5.recordAttempt(A)
  const first5 = s5.onFailure({ code: 'SERVER' })
  assert.equal(first5.action, 'retry')
  clock += 500
  const timedOut = s5.onFailure({ code: 'SERVER' })
  assert.equal(timedOut.action, 'stop')
  assert.equal(timedOut.reason, 'total-time-limit')
  assert.equal(timedOut.exhausted, true)
  // abort：绝不切
  const s6 = createRouteSession({ initial: A, alternatives: [B], now: () => clock })
  s6.recordAttempt(A)
  const aborted = s6.onFailure({ code: 'ABORTED' }, { aborted: true })
  assert.equal(aborted.action, 'stop')
  assert.equal(aborted.reason, 'aborted')
  // 不可切类 → stop 且不 exhausted（如实失败，不是"候选耗尽"）
  const s7 = createRouteSession({ initial: A, alternatives: [B], now: () => clock })
  s7.recordAttempt(A)
  const never = s7.onFailure({ code: 'TOOL_ERROR' })
  assert.equal(never.action, 'stop')
  assert.equal(never.exhausted, false)
  // summary 非秘密、可回显
  const summary = s7.summary()
  assert.equal(typeof summary.switches, 'number')
  assert.equal(summary.current.provider, 'p')
  assert.equal(DEFAULT_ROUTE_LIMITS.maxCandidates, 3, '默认最多 3 个不同候选（含首次）')
})
