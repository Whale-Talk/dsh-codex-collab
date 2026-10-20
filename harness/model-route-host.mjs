/**
 * 动态模型路由的**宿主接线**（M2，第二轮验收修正版）。
 *
 * 第二轮修正要点（逐条对应 Root 第二轮反例）：
 *  1. `agent/request-error` 必须 **prepend**，且托管任务**拥有恢复/终止权**：耗尽抛结构化错误终止、
 *     其它终态直接 `return undefined` **不调 next**（`llm-retry` 的 always 在**外层**，append/交给 next 会被吞并重试）。
 *  2. 生命周期用 **closed + generation 门闩**：每个 await 之后、写盘/计数/返回配置之前复核；卸载即释放等待。
 *  3. 意图跨**连续托管任务**保留真实基线（不把我们的覆盖当成新的用户基线）；人工 `model/selection`
 *     事件（同值也算明确重选）优先于字符串比较；恢复是**完整合法配置**（清掉我们带上的 effort/maxTokens）。
 *  4. worker 必须核对 **expectedOwner + exact live 对象 + isOwnedBy**；拿不到 owner 就 fail-closed 不绑定。
 */
import { createModelCatalog, selectRoute, createRouteSession, classifyFailure, boundedDelay, DEFAULT_ROUTE_LIMITS } from './model-routing.mjs'

export const AUDIT_KINDS = ['plan', 'first-request', 'attempt', 'switch', 'stop', 'finish', 'restore', 'unbound', 'respect-human-selection']

const sanitizePolicy = (raw) => {
  const policy = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = typeof policy.mode === 'string' && ['auto', 'fast', 'pro', 'inherit', 'exact'].includes(policy.mode) ? policy.mode : 'auto'
  return {
    mode,
    provider: typeof policy.provider === 'string' && policy.provider !== '' ? policy.provider : undefined,
    model: typeof policy.model === 'string' && policy.model !== '' ? policy.model : undefined,
    allowFallback: policy.allowFallback === undefined ? (mode === 'auto' || mode === 'fast' || mode === 'pro') : policy.allowFallback === true,
    taskKind: typeof policy.taskKind === 'string' ? policy.taskKind : 'code',
    needs: policy.needs !== null && typeof policy.needs === 'object' ? policy.needs : {},
  }
}

const sessionIdOf = (agent) => {
  if (agent === null || agent === undefined) return undefined
  if (typeof agent.sessionId === 'string') return agent.sessionId
  const session = agent.session
  if (session !== null && session !== undefined && typeof session.id === 'string') return session.id
  if (session !== null && session !== undefined && session.header !== undefined && session.header !== null && typeof session.header.id === 'string') return session.header.id
  return undefined
}

/** 完整配置快照（含"没有 effort/maxTokens"这一事实——恢复时据此清除我们带上的残留）。 */
const cfgOf = (config) => ({
  provider: config.provider,
  model: config.model,
  ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
})

export const createModelRouting = (options = {}) => {
  const ctx = options.ctx
  const llm = options.llm
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const agentsOf = typeof options.agents === 'function' ? options.agents : () => undefined
  const auditSink = typeof options.audit === 'function' ? options.audit : null
  const readSessionEvents = typeof options.readSessionEvents === 'function' ? options.readSessionEvents : null
  const limits = { ...DEFAULT_ROUTE_LIMITS, ...(options.limits || {}) }
  const maxRetryAfterMs = Number.isFinite(options.maxRetryAfterMs) ? options.maxRetryAfterMs : 30_000

  const catalog = createModelCatalog({ llm, now })
  const cooldowns = new Map()
  const plans = new Map()
  const routes = new Map()
  const routeKeyOfAgent = new Map()
  /** agentId → { baseline:完整cfg, override:{provider,model}, taskId, recordedSeq }（跨连续托管任务保留） */
  const intents = new Map()
  const audit = []
  const counters = { plans: 0, firstRequests: 0, attempts: 0, switches: 0, stops: 0, restores: 0, unboundRequests: 0, rejectedBindings: 0, retryAfterWaits: 0, exhaustedAborts: 0, unloadedDrops: 0, humanSelections: 0 }
  /** 生命周期门闩：uninstall 后任何异步返回都不得改配置/写盘/计数。 */
  let closed = false
  let generation = 0
  const isLive = () => closed !== true

  const emit = (record) => {
    if (!isLive()) { counters.unloadedDrops += 1; return null }
    const entry = { at: now(), ...record }
    audit.push(entry)
    if (audit.length > 800) audit.shift()
    if (auditSink !== null) { try { const r = auditSink(entry); if (r !== undefined && typeof r.then === 'function') r.catch(() => {}) } catch (e) { /* 审计失败绝不影响执行 */ } }
    return entry
  }

  const liveAgentOf = (agentId) => {
    const live = agentsOf()
    if (live === undefined || live === null || typeof live.get !== 'function') return undefined
    try { return live.get(agentId) } catch (e) { return undefined }
  }
  const isOwnedBy = (childId, owner) => {
    const live = agentsOf()
    if (live === undefined || live === null || typeof live.isOwnedBy !== 'function') return null   // 无法证明 → null（fail-closed）
    try { return live.isOwnedBy(childId, owner) === true } catch (e) { return null }
  }

  /** 官方选择意图：会话里最后一条 `model/selection` 的 seq（同值也算"人工明确重选"）。 */
  const latestSelectionSeq = async (agent) => {
    if (readSessionEvents === null) return null
    const sessionId = sessionIdOf(agent)
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let events = null
    try { events = await readSessionEvents(sessionId) } catch (e) { return undefined }
    if (!Array.isArray(events)) return undefined
    let seq = null
    for (const e of events) {
      if (e === null || typeof e !== 'object') continue
      if (e.type !== 'model/selection') continue
      if (typeof e.seq === 'number') seq = seq === null ? e.seq : Math.max(seq, e.seq)
    }
    return seq
  }

  const planRoute = async ({ taskId, policy, kind, execution, originThreadId, sessionId, childId, expectedOwner, onExhausted, onTerminal }) => {
    const normalized = sanitizePolicy(policy)
    const gen = generation
    // **执行目标与业务 kind 解耦**：业务 kind 只是 task/review，用哪个通道执行由 target/预分配 childId 决定。
    const execTarget = execution !== undefined && (execution === 'session' || execution === 'worker')
      ? execution
      : (typeof childId === 'string' && childId !== '' ? 'worker' : 'session')
    let selection = null
    if (normalized.mode !== 'inherit') {
      selection = await selectRoute({
        catalog,
        request: { mode: normalized.mode, provider: normalized.provider, model: normalized.model, taskKind: normalized.taskKind, needs: normalized.needs, allowFallback: normalized.allowFallback },
        resolveInfo: catalog.resolveInfo,
      })
    } else if (normalized.allowFallback === true) {
      selection = await selectRoute({ catalog, request: { mode: 'inherit', allowFallback: true, taskKind: normalized.taskKind, needs: normalized.needs }, resolveInfo: catalog.resolveInfo })
    }
    // 门闩：目录/能力 await 之后若已卸载或换代 → **不写盘、不计数、不登记**
    if (!isLive() || gen !== generation) { counters.unloadedDrops += 1; return { cancelled: true, taskId } }
    const plan = { taskId, kind, execution: execTarget, originThreadId, sessionId, childId, expectedOwner, policy: normalized, selection, createdAt: now(), bound: false, onExhausted, onTerminal }
    plans.set(taskId, plan)
    counters.plans += 1
    emit({
      kind: 'plan', taskId, originThreadId, sessionId, taskKind: normalized.taskKind, businessKind: kind, execution: execTarget,
      mode: normalized.mode, allowFallback: normalized.allowFallback,
      chosen: selection !== null && selection.ok === true ? { provider: selection.pair.provider, model: selection.pair.model } : null,
      reason: selection === null ? 'inherit' : selection.reason,
      ...(execTarget === 'worker' ? { childId, expectedOwner } : {}),
      ...(selection !== null && selection.ok !== true ? { rejected: selection.rejected === undefined ? undefined : selection.rejected.slice(0, 5) } : {}),
    })
    return plan
  }

  const routesForAgent = (agentId) => {
    const set = routeKeyOfAgent.get(agentId)
    return set === undefined ? [] : Array.from(set).map((key) => routes.get(key)).filter((r) => r !== undefined)
  }

  const retireBinding = (binding, reason) => {
    if (binding === undefined || binding === null || binding.active !== true) return
    binding.active = false
    if (typeof binding.wake === 'function') { try { binding.wake() } catch (e) { /* ignore */ } }
    const key = binding.agentId + '\u0000' + binding.taskId
    routes.delete(key)
    const set = routeKeyOfAgent.get(binding.agentId)
    if (set !== undefined) { set.delete(key); if (set.size === 0) routeKeyOfAgent.delete(binding.agentId) }
    emit({ kind: 'finish', taskId: binding.taskId, status: 'retired', reason })
  }

  /** 绑定查找：exact live 对象 + **本任务那一个 turn**；turn 迁移即失活。 */
  const bindingFor = (agent, turn, step) => {
    if (agent === null || agent === undefined || typeof agent.id !== 'string') return null
    const candidates = routesForAgent(agent.id).filter((r) => r.active === true)
    if (candidates.length === 0) return null
    const live = liveAgentOf(agent.id)
    for (const binding of candidates) {
      if (binding.agent !== agent) continue
      if (live !== undefined && live !== agent) continue
      if (Number.isInteger(binding.boundTurn) && Number.isInteger(turn) && binding.boundTurn !== turn) {
        retireBinding(binding, 'turn-moved-on')
        continue
      }
      return binding
    }
    return null
  }

  /** 未绑定请求：官方选择事件优先，其次逐 agent 真实基线；恢复是**完整合法配置**。 */
  const unboundDecision = async (agent, base) => {
    counters.unboundRequests += 1
    if (agent === null || agent === undefined || typeof agent.id !== 'string') return null
    const intent = intents.get(agent.id)
    if (intent === undefined) return null
    const lastSelection = await latestSelectionSeq(agent)
    if (!isLive()) return null
    if (lastSelection === undefined) return null // No fresh evidence: do not restore over an unseen human choice.
    if (lastSelection !== null && (intent.recordedSeq === null || intent.recordedSeq === undefined || lastSelection > intent.recordedSeq)) {
      counters.humanSelections += 1
      intents.delete(agent.id)
      emit({ kind: 'respect-human-selection', taskId: intent.taskId, agentId: agent.id, selectionSeq: lastSelection, recordedSeq: intent.recordedSeq === undefined ? null : intent.recordedSeq })
      return null
    }
    const proposalsOurOverride = base !== null && base !== undefined && base.provider === intent.override.provider && base.model === intent.override.model
    if (!proposalsOurOverride) { intents.delete(agent.id); return null }
    const restored = { ...base, provider: intent.baseline.provider, model: intent.baseline.model }
    if (intent.baseline.reasoningEffort === undefined) delete restored.reasoningEffort
    else restored.reasoningEffort = intent.baseline.reasoningEffort
    if (intent.baseline.maxTokens === undefined) delete restored.maxTokens
    else restored.maxTokens = intent.baseline.maxTokens
    counters.restores += 1
    emit({ kind: 'restore', taskId: intent.taskId, agentId: agent.id, from: { provider: intent.override.provider, model: intent.override.model }, to: { provider: intent.baseline.provider, model: intent.baseline.model }, reason: 'restore-per-agent-baseline' })
    intents.delete(agent.id)
    return restored
  }

  /** 按目标能力处理 effort/maxTokens（只调这两个字段，不删图/不截历史/不重放工具）。 */
  const compatibleConfig = async (base, pair) => {
    const next = { ...base, provider: pair.provider, model: pair.model }
    const info = await catalog.resolveInfo(pair.provider, pair.model)
    const cap = info.ok === true ? info.capability : null
    const efforts = cap !== null && Array.isArray(cap.efforts) ? cap.efforts : null
    if (base.reasoningEffort !== undefined) {
      if (efforts !== null) {
        if (!efforts.includes(base.reasoningEffort)) {
          if (typeof cap.defaultEffort === 'string' && efforts.includes(cap.defaultEffort)) next.reasoningEffort = cap.defaultEffort
          else delete next.reasoningEffort
        }
      } else delete next.reasoningEffort
    }
    if (cap !== null && Number.isFinite(cap.defaultMaxTokens)) {
      if (!Number.isFinite(next.maxTokens) || next.maxTokens > cap.defaultMaxTokens) next.maxTokens = cap.defaultMaxTokens
    }
    return next
  }

  /** 记录/延续该 agent 的**真实基线**（跨连续托管任务保留；绝不把我们的覆盖当基线）。 */
  const rememberIntent = (agentId, base, override, taskId, recordedSeq) => {
    const prev = intents.get(agentId)
    const proposalsOurPreviousOverride = prev !== undefined && prev.override !== undefined && base.provider === prev.override.provider && base.model === prev.override.model
    const baseline = proposalsOurPreviousOverride ? prev.baseline : cfgOf(base)
    const carrySeq = proposalsOurPreviousOverride && prev.recordedSeq !== undefined ? prev.recordedSeq : recordedSeq
    intents.set(agentId, { baseline, override: { provider: override.provider, model: override.model }, taskId, recordedSeq: carrySeq })
    return baseline
  }

  const onRequest = async (payload, next) => {
    const base = await next()
    if (!isLive()) return base                                   // 卸载后绝不改请求
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    const turn = payload !== null && typeof payload === 'object' && Number.isInteger(payload.turn) ? payload.turn : undefined
    const step = payload !== null && typeof payload === 'object' && Number.isInteger(payload.step) ? payload.step : undefined
    const binding = bindingFor(agent, turn, step)
    if (binding === null) {
      const restored = await unboundDecision(agent, base)
      if (!isLive() || restored === null) return base             // await 后门闩
      return restored
    }
    counters.attempts += 1
    const recordedSeq = await latestSelectionSeq(agent)
    if (!isLive() || binding.active !== true) return base          // await 后门闩（选择/能力查询在途卸载）
    const summary = binding.routeSession === null ? null : binding.routeSession.summary()
    const target = binding.pendingTarget !== undefined && binding.pendingTarget !== null ? binding.pendingTarget : (summary === null ? null : summary.current)
    if (target === null || target === undefined || typeof target.provider !== 'string') return base
    const nextConfig = await compatibleConfig(base, target)
    // 能力解析 await 之后：卸载/失活 → 绝不改配置、绝不写审计（Root 第二轮反例 2/3e）
    if (!isLive() || binding.active !== true) return base
    if (binding.routeSession !== null) {
      binding.routeSession.recordAttempt({ provider: nextConfig.provider, model: nextConfig.model }, { turn, step })
      if (binding.pendingTarget !== undefined) binding.pendingTarget = undefined
    }
    rememberIntent(agent.id, base, nextConfig, binding.taskId, recordedSeq)
    if (binding.firstRequestDone !== true) {
      binding.firstRequestDone = true
      counters.firstRequests += 1
      emit({ kind: 'first-request', taskId: binding.taskId, turn, step, provider: nextConfig.provider, model: nextConfig.model, reason: binding.planReason })
    } else {
      emit({ kind: 'attempt', taskId: binding.taskId, turn, step, provider: nextConfig.provider, model: nextConfig.model })
    }
    return nextConfig
  }

  const onRequestError = async (payload, next) => {
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    const turn = payload !== null && typeof payload === 'object' ? payload.turn : undefined
    const step = payload !== null && typeof payload === 'object' ? payload.step : undefined
    const binding = bindingFor(agent, turn, step)
    if (binding === null) return next()                          // 未托管：交还下游
    if (!isLive() || binding.active !== true) return next()
    const failure = payload !== null && typeof payload === 'object' ? payload.failure : undefined
    const classified = classifyFailure(failure)
    emit({
      kind: 'failure', taskId: binding.taskId, turn, step,
      provider: payload !== null && typeof payload.provider === 'string' ? payload.provider : undefined,
      code: classified.code, action: classified.action, reason: classified.reason,
    })
    const aborted = payload !== null && payload.signal !== undefined && payload.signal !== null && payload.signal.aborted === true
    /** 托管任务**拥有终态权**：耗尽抛出结构化终止；其它终态 return undefined（都不调 next，always 在外层会吞掉 next 后继续）。 */
    const ownedTerminal = (reason, code, exhausted) => {
      counters.stops += 1
      emit({ kind: 'stop', taskId: binding.taskId, reason, ...(code === undefined ? {} : { code }), exhausted })
      // 终态事实通知宿主（**只记录/收口本任务**，不 abort 观察者、不 cancel Agent、不碰其他 queue）
      if (typeof binding.onTerminal === 'function') {
        try { binding.onTerminal({ reason, code, exhausted: exhausted === true }) } catch (e) { /* ignore */ }
      }
      if (exhausted) {
        counters.exhaustedAborts += 1
        if (typeof binding.onExhausted === 'function') { try { binding.onExhausted(reason) } catch (e) { /* ignore */ } }
        const stopError = new Error('model routing budget exhausted: ' + reason)
        stopError.code = 'MODEL_ROUTE_EXHAUSTED'
        stopError.reason = reason
        throw stopError
      }
      return undefined
    }
    if (binding.policy.allowFallback !== true) return ownedTerminal('fallback-disabled', classified.code, false)
    if (binding.routeSession === null) return ownedTerminal('no-route-pool', classified.code, false)
    const decision = binding.routeSession.onFailure(failure, { aborted })
    if (decision.action !== 'retry') return ownedTerminal(decision.reason, decision.code, decision.exhausted === true)
    if (decision.switched === true) {
      counters.switches += 1
      const summary2 = binding.routeSession.summary()
      const lastSwitch = summary2.switchLog[summary2.switchLog.length - 1]
      emit({ kind: 'switch', taskId: binding.taskId, turn, step, from: lastSwitch === undefined ? null : lastSwitch.from, to: lastSwitch === undefined ? null : lastSwitch.to, code: classified.code, reason: decision.reason, switchCount: summary2.switches })
    }
    if (Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0) {
      counters.retryAfterWaits += 1
      const waitMs = Math.min(decision.retryAfterMs, maxRetryAfterMs)
      emit({ kind: 'attempt', taskId: binding.taskId, note: 'retry-after-wait', waitMs })
      await boundedDelay(waitMs, { isCancelled: () => binding.active !== true || !isLive() })
      if (!isLive() || binding.active !== true) return undefined      // 卸载/失活 → 不再重试
    }
    binding.pendingTarget = { provider: decision.pair.provider, model: decision.pair.model }
    return { kind: 'retry' }
  }

  /**
   * 首请求归属的**统一口径**（execution 决定通道；rpcId 只是关联标识，**不是授权**）：
   *  - exact live registry 对象（ID 不能代替对象身份）；
   *  - worker 执行目标：**精确 childId** + 可信 expectedOwner（当前 live 对象）+ 官方 isOwnedBy + parent lineage；
   *  - session 执行目标：claimed session 必须等于登记 session；
   *  - 任何一项失败 → 拒绝且**不消耗 plan**（真正的预期 child 之后仍可认领）。
   */
  const verifyClaim = (plan, agent, live) => {
    const workerTarget = plan.execution === 'worker' || (typeof plan.childId === 'string' && plan.childId !== '')
    const registry = agentsOf()
    const registryHasGet = registry !== undefined && registry !== null && typeof registry.get === 'function'
    if (registryHasGet) {
      if (live === undefined || live === null) return { ok: false, reason: 'registry-missing' }
      if (live !== agent) return { ok: false, reason: 'registry-epoch-mismatch' }
    }
    if (workerTarget) {
      if (typeof plan.childId !== 'string' || plan.childId === '') return { ok: false, reason: 'worker-child-unknown' }
      // 错 child（另一 parent 的 child / 同 parent 的另一 child）一律拒绝：rpcId 相同也不行
      if (plan.childId !== agent.id) return { ok: false, reason: 'worker-child-mismatch', claimedChildId: agent.id, expectedChildId: plan.childId }
      if (typeof plan.expectedOwner !== 'string' || plan.expectedOwner === '') return { ok: false, reason: 'worker-owner-unknown' }
      const ownerAgent = liveAgentOf(plan.expectedOwner)
      if (registryHasGet && (ownerAgent === undefined || ownerAgent === null)) return { ok: false, reason: 'worker-owner-not-live', expectedOwner: plan.expectedOwner }
      const owned = isOwnedBy(agent.id, ownerAgent)
      if (owned !== true) return { ok: false, reason: owned === false ? 'worker-owner-mismatch' : 'worker-owner-unverifiable', expectedOwner: plan.expectedOwner }
      const header = agent !== null && agent !== undefined && agent.session !== null && agent.session !== undefined ? agent.session.header : undefined
      const parentSession = header !== null && header !== undefined ? header.parentSession : undefined
      if (parentSession !== undefined && parentSession !== null && parentSession !== plan.expectedOwner) {
        return { ok: false, reason: 'worker-lineage-mismatch', parentSession, expectedOwner: plan.expectedOwner }
      }
      return { ok: true }
    }
    if (plan.sessionId !== undefined && plan.sessionId !== null) {
      const claimedSession = sessionIdOf(agent)
      const liveSession = sessionIdOf(live)
      if (claimedSession !== undefined && claimedSession !== plan.sessionId) return { ok: false, reason: 'session-mismatch', claimedSession, expectedSession: plan.sessionId }
      if (claimedSession === undefined && liveSession !== undefined && liveSession !== plan.sessionId) return { ok: false, reason: 'live-session-mismatch', claimedSession: liveSession, expectedSession: plan.sessionId }
    }
    return { ok: true }
  }

  const onClaimed = (payload) => {
    if (!isLive()) return
    const message = payload !== null && typeof payload === 'object' ? payload.message : undefined
    const source = message !== null && message !== undefined && typeof message.source === 'object' && message.source !== null ? message.source : {}
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    const turn = payload !== null && typeof payload === 'object' && Number.isInteger(payload.turn) ? payload.turn : undefined
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId : undefined
    if (agent === undefined || typeof agent.id !== 'string') return
    const live = liveAgentOf(agent.id)
    let plan
    if (rpcId !== undefined) {
      plan = plans.get(rpcId)
      if (plan === undefined || plan.bound === true) return
    } else {
      // 无 rpcId 的 worker 首输入：只按**精确 childId** 唯一匹配预登记 plan
      const matches = Array.from(plans.values()).filter((p) => p.bound !== true && typeof p.childId === 'string' && p.childId !== '' && p.childId === agent.id)
      if (matches.length !== 1) { if (matches.length > 1) counters.rejectedBindings += 1; return }
      plan = matches[0]
    }
    const verdict = verifyClaim(plan, agent, live)
    if (verdict.ok !== true) {
      counters.rejectedBindings += 1
      const { ok, reason, ...details } = verdict
      emit({ kind: 'unbound', taskId: plan.taskId, reason, ...details })
      return false   // 不消耗 plan：真正的预期 child 之后仍能认领
    }
    const routeSession = plan.selection !== null && plan.selection.ok === true
      ? createRouteSession({
          initial: { provider: plan.selection.pair.provider, model: plan.selection.pair.model },
          alternatives: (plan.selection.alternatives || []).map((a) => ({ provider: a.provider, model: a.model })),
          cooldowns, now, limits,
        })
      : (plan.policy.allowFallback === true && plan.selection !== null && Array.isArray(plan.selection.alternatives)
        ? createRouteSession({ initial: null, alternatives: plan.selection.alternatives.map((a) => ({ provider: a.provider, model: a.model })), cooldowns, now, limits })
        : null)
    const binding = {
      taskId: plan.taskId, plan, policy: plan.policy, agent, agentId: agent.id,
      routeSession, pendingTarget: undefined, boundTurn: turn, firstRequestDone: false, active: true,
      planReason: plan.selection === null ? 'inherit' : (plan.selection.ok === true ? plan.selection.reason : 'selection-failed:' + plan.selection.reason),
      onExhausted: plan.onExhausted,
      onTerminal: plan.onTerminal,
      createdAt: now(),
    }
    const key = agent.id + '\u0000' + plan.taskId
    routes.set(key, binding)
    const set = routeKeyOfAgent.get(agent.id)
    if (set === undefined) routeKeyOfAgent.set(agent.id, new Set([key]))
    else set.add(key)
    plan.bound = true
    emit({
      kind: 'first-request-bound', taskId: plan.taskId, agentId: agent.id, turn,
      businessKind: plan.kind, execution: plan.execution,
      ...(rpcId === undefined ? { via: 'worker-childId+owner', expectedOwner: plan.expectedOwner } : { via: 'agent/inbox/claimed', rpcId }),
    })
    return binding
  }

  const finishRoute = ({ taskId, status, reason }) => {
    const plan = plans.get(taskId)
    const affected = Array.from(routes.values()).filter((r) => r.taskId === taskId)
    const summary = affected.length > 0 && affected[0].routeSession !== null ? affected[0].routeSession.summary() : null
    for (const binding of affected) retireBinding(binding, 'task-finished:' + String(status))
    if (plan !== undefined) plans.delete(taskId)
    emit({
      kind: 'finish', taskId, status,
      ...(reason === undefined ? {} : { reason }),
      switches: summary === null ? 0 : summary.switches,
      attempts: summary === null ? 0 : summary.attempts,
      ...(summary === null ? {} : { current: summary.current, lastFailure: summary.lastFailure === null ? null : { code: summary.lastFailure.code, action: summary.lastFailure.action } }),
    })
    return summary
  }

  const modelsView = async ({ force = false } = {}) => {
    const snap = await catalog.snapshot({ force })
    const at = now()
    const cooldownView = Array.from(cooldowns.entries()).filter(([, until]) => until > at).map(([key, until]) => {
      const [provider, model] = key.split('\u0000')
      return { provider, model, until, remainingMs: until - at }
    })
    return {
      ok: true,
      fetchedAt: snap.at,
      servedFromCache: snap.servedFromCache === true,
      unavailable: snap.unavailable === true,
      pairs: (snap.pairs || []).map((p) => ({ provider: p.provider, model: p.model, name: p.name })),
      failures: snap.failures || [],
      cooldowns: cooldownView,
      note: '目录只说明"已注册且已列出"；这不等于凭据/额度/远端健康已验证，也没有质量/价格/评分。',
    }
  }

  const status = () => ({
    plans: counters.plans,
    boundRoutes: routes.size,
    counters: { ...counters },
    limits: { ...limits },
    live: isLive(),
    generation,
    auditTail: audit.slice(-10),
  })

  /** 官方会话事件：turn/end 即时失活；model/selection 记录为"人工明确选择"。 */
  const installSessionListeners = () => {
    const offs = []
    const handler = (payload) => {
      try {
        const agent = payload !== null && typeof payload === 'object' ? (payload.agent !== undefined ? payload.agent : payload) : undefined
        const event = payload !== null && typeof payload === 'object' && payload.event !== undefined ? payload.event : payload
        if (event === null || event === undefined || typeof event.type !== 'string') return
        if (event.type === 'model/selection' && agent !== undefined && typeof agent.id === 'string') {
          const intent = intents.get(agent.id)
          const seq = event.seq !== undefined && Number.isInteger(event.seq) ? event.seq : Number.MAX_SAFE_INTEGER
          if (intent !== undefined) { counters.humanSelections += 1; intents.set(agent.id, { ...intent, recordedSeq: seq, humanSelected: true }) }
          return
        }
        if (event.type !== 'turn/end') return
        const turn = event.data !== undefined && event.data !== null && Number.isInteger(event.data.turn) ? event.data.turn : undefined
        if (agent === undefined || typeof agent.id !== 'string') return
        for (const binding of routesForAgent(agent.id)) {
          if (turn === undefined || binding.boundTurn === turn) retireBinding(binding, 'official-turn-end')
        }
      } catch (e) { /* 失活失败不影响执行 */ }
    }
    for (const name of ['session/event', 'session/events']) {
      try {
        const off = ctx.on(name, handler)
        if (typeof off === 'function') offs.push(off)
      } catch (e) { /* 事件名不存在 → 忽略 */ }
    }
    return () => { for (const off of offs) { try { off() } catch (e) { /* ignore */ } } }
  }

  const install = () => {
    if (ctx === undefined || typeof ctx.on !== 'function') return () => {}
    closed = false
    generation += 1
    const offs = []
    offs.push(ctx.on('agent/inbox/claimed', (payload) => { try { onClaimed(payload) } catch (e) { /* 归属失败绝不影响执行 */ } }))
    offs.push(ctx.on('agent/request', (payload, next) => onRequest(payload, next), { prepend: true }))
    // **prepend** 是必须的：llm-retry 的 always 在外层，append 会被 settleDownstream 吞掉后继续重试。
    offs.push(ctx.on('agent/request-error', (payload, next) => onRequestError(payload, next), { prepend: true }))
    const offSession = installSessionListeners()
    let offAdapters = null
    try { offAdapters = ctx.on('llm/adapters-updated', () => { catalog.invalidate() }) } catch (e) { offAdapters = null }
    return () => {
      // 卸载：先关门（此后所有异步返回都不得改配置/写盘/计数），再卸监听、失活绑定、释放等待
      closed = true
      generation += 1
      for (const off of offs) { try { if (typeof off === 'function') off() } catch (e) { /* ignore */ } }
      try { offSession() } catch (e) { /* ignore */ }
      if (typeof offAdapters === 'function') { try { offAdapters() } catch (e) { /* ignore */ } }
      for (const binding of Array.from(routes.values())) { binding.active = false; if (typeof binding.wake === 'function') { try { binding.wake() } catch (e) { /* ignore */ } } }
      routes.clear()
      routeKeyOfAgent.clear()
      plans.clear()
      intents.clear()
      emit({ kind: 'finish', taskId: null, status: 'unloaded' })
    }
  }

  return {
    planRoute, finishRoute, modelsView, status, install, onClaimed, onRequest, onRequestError,
    catalog, cooldowns, limits,
    isBound: (taskId) => Array.from(routes.values()).some((r) => r.taskId === taskId),
    auditView: (taskId) => audit.filter((e) => taskId === undefined || e.taskId === taskId),
    intentFor: (agentId) => intents.get(agentId),
  }
}
