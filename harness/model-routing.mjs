/**
 * 动态模型路由（M1）：目录快照、候选选择与有界故障切换。
 *
 * 设计约束（来自 Root canonical 计划与 SDK 只读笔记）：
 *  - 只用公有 API `llm.listProviders/listModels/resolveModelInfo/resolveCallConfig`；只枚举**已注册**配置；
 *    目录可见 ≠ 凭据/额度/健康已验证（本模块从不把 catalog 当健康结论）。
 *  - provider+model 是**唯一身份（pair）**：跨 provider 同名模型绝不合并。
 *  - 目录失败**按 provider 隔离**；缓存有界且可失效；**永不永久缓存 null**。
 *  - 元数据没有质量/价格/速度评分；`toolUpdate` 是历史投影规则，**不当作"支持工具"布尔**。
 *  - 先满足真实模态/上下文/effort 与用户显式选择，再按 DeepSeek 偏好与可解释名称提示排序。
 *  - 失败分类只用**稳定 code/status**；切换有界（默认最多 3 个不同候选、单路与总时限）。
 *
 * 本模块**不**：调用 selectModel/saveSelection、写 readonly options、改全局 preset、发起任何网络请求。
 */

/** 目录快照默认 TTL（毫秒）。拓扑变更事件会主动失效。 */
export const CATALOG_TTL_MS = 30_000
/** 目录失败（某 provider）的短冷却：**不永久缓存 null**，到期后重新尝试。 */
export const CATALOG_FAILURE_TTL_MS = 5_000
/** 单次快照最多枚举的 provider / 每 provider 模型数（有界）。 */
export const MAX_PROVIDERS = 32
export const MAX_MODELS_PER_PROVIDER = 200

export const ROUTE_MODES = ['auto', 'fast', 'pro', 'inherit', 'exact']

/** 稳定失败码分类（不读 message 文本）。 */
export const SWITCHABLE_CODES = new Set([
  'AUTH', 'MISSING_CREDENTIAL', 'ACCOUNT_QUOTA', 'QUOTA', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'NO_ADAPTER',
])
export const RETRYABLE_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
/** 明确**不**靠切模型绕过：用户取消、拒答/安全、审批、工具错误、请求本身非法、未知插件 bug。 */
export const NEVER_SWITCH_CODES = new Set([
  'ABORTED', 'USER_ABORT', 'CANCELLED', 'SAFETY', 'CONTENT_FILTER', 'REFUSAL',
  'TOOL_ERROR', 'TOOL_FAILED', 'APPROVAL_DENIED', 'APPROVAL_REJECTED', 'INVALID_REQUEST', 'UNSUPPORTED_REASONING_EFFORT',
])

const pairKey = (provider, model) => String(provider) + '\u0000' + String(model)
export const pairOf = (provider, model) => ({ provider, model, key: pairKey(provider, model) })

/** 有界等待/超时（目录发现、retry-after 都用它；绝不无限等）。 */
export const withDeadline = (promise, ms, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    if (typeof onTimeout === 'function') { try { onTimeout() } catch (e) { /* ignore */ } }
    reject(Object.assign(new Error('deadline exceeded after ' + ms + 'ms'), { code: 'DEADLINE_EXCEEDED' }))
  }, Math.max(1, ms))
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value) },
    (error) => { clearTimeout(timer); reject(error) },
  )
})

/** 有界延时（retry-after 用）：到点或被 signal/aborted 立刻返回，绝不无限等。 */
export const boundedDelay = (ms, options = {}) => new Promise((resolve) => {
  const cap = Number.isFinite(options.maxMs) ? Math.max(0, Math.min(ms, options.maxMs)) : Math.max(0, ms)
  let done = false
  const finish = () => { if (done) return; done = true; clearTimeout(timer); if (typeof options.onWake === 'function') options.onWake(); resolve() }
  const timer = setTimeout(finish, cap)
  const signal = options.signal
  if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
    if (signal.aborted === true) { finish(); return }
    signal.addEventListener('abort', finish, { once: true })
  }
  if (typeof options.isCancelled === 'function' && options.isCancelled() === true) finish()
})

const modelIdOf = (entry) => {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return ''
  return typeof entry.id === 'string' && entry.id !== '' ? entry.id : (typeof entry.name === 'string' ? entry.name : '')
}

const modalitiesOf = (info) => {
  // 未知 → 返回 undefined（诚实标未知，不伪造支持）
  const raw = info !== null && typeof info === 'object' ? (info.inputModalities !== undefined ? info.inputModalities : (info.model !== undefined ? info.model.inputModalities : undefined)) : undefined
  if (!Array.isArray(raw)) return undefined
  return raw.filter((m) => typeof m === 'string')
}

/** 单 provider 目录发现的有界超时（防止一个挂死的 adapter 拖住所有候选）。 */
export const PROVIDER_DISCOVERY_TIMEOUT_MS = 3000

/**
 * 从 ResolvedModelInfo 提取可解释能力（缺字段 = 未知，绝不当作"支持"）。
 * 注意：官方 `reasoning.efforts` 是**对象数组** `[{id,name}, ...]`（SDK 实测），
 * 也兼容字符串数组；只滤 string 会把支持的 effort 全判成空数组（第一版验收反例）。
 */
export const capabilityOf = (info) => {
  const out = { known: false }
  if (info === null || typeof info !== 'object') return out
  const context = info.context !== null && typeof info.context === 'object' ? info.context : undefined
  if (context !== undefined && Number.isFinite(context.contextWindow)) { out.contextWindow = context.contextWindow; out.known = true }
  if (Number.isFinite(info.defaultMaxTokens)) { out.defaultMaxTokens = info.defaultMaxTokens; out.known = true }
  const reasoning = info.reasoning !== null && typeof info.reasoning === 'object' ? info.reasoning : undefined
  if (reasoning !== undefined) {
    if (Array.isArray(reasoning.efforts)) {
      const ids = []
      for (const entry of reasoning.efforts) {
        if (typeof entry === 'string') { ids.push(entry); continue }
        if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') ids.push(entry.id)
      }
      out.efforts = ids
    }
    const defaultEffort = reasoning.defaultEffort
    if (typeof defaultEffort === 'string') out.defaultEffort = defaultEffort
    else if (defaultEffort !== null && typeof defaultEffort === 'object' && typeof defaultEffort.id === 'string') out.defaultEffort = defaultEffort.id
    out.known = true
  }
  const modalities = modalitiesOf(info)
  if (modalities !== undefined) { out.inputModalities = modalities; out.known = true }
  // toolUpdate/systemPromptUpdate 是**历史投影规则**，只作为附加事实保留，绝不当"支持工具"布尔。
  const toolUpdate = info.toolUpdate !== undefined ? info.toolUpdate : (info.model !== undefined ? info.model.toolUpdate : undefined)
  if (typeof toolUpdate === 'string' || (toolUpdate !== null && typeof toolUpdate === 'object')) out.toolUpdateRule = toolUpdate
  return out
}

/** 已证不可用的解析失败码（必须**排除**候选，不能降级成"未知能力"再送去准备期失败）。 */
export const UNRESOLVABLE_CAPABILITY_CODES = new Set(['UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'INVALID_CONFIG', 'NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT'])

/**
 * 目录快照：provider 失败隔离、有界缓存、可主动失效、失败**不永久**缓存。
 * `llm` 为官方 Llm 服务（listProviders/listModels/resolveModelInfo）。
 */
export const createModelCatalog = (options = {}) => {
  const llm = options.llm
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : CATALOG_TTL_MS
  const failureTtlMs = Number.isFinite(options.failureTtlMs) ? options.failureTtlMs : CATALOG_FAILURE_TTL_MS
  const providerTimeoutMs = Number.isFinite(options.providerTimeoutMs) ? options.providerTimeoutMs : PROVIDER_DISCOVERY_TIMEOUT_MS
  let cache = null            // { at, pairs, failures }
  const providerFailures = new Map()   // provider → { at, reason }
  const infoCache = new Map()          // pairKey → { at, info }

  const invalidate = () => { cache = null; infoCache.clear() }

  const snapshot = async ({ force = false } = {}) => {
    const at = now()
    if (!force && cache !== null && at - cache.at < ttlMs) return { ...cache, stale: false, servedFromCache: true }
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
      return { at, pairs: [], failures: [{ provider: '*', reason: 'llm-unavailable', retryable: true }], stale: false, servedFromCache: false, unavailable: true }
    }
    const pairs = []
    const failures = []
    let providers = []
    try {
      providers = await llm.listProviders()
    } catch (e) {
      // 整个目录不可用：不缓存成"空目录"结论，只记一次失败（下次仍尝试）。
      return { at, pairs: [], failures: [{ provider: '*', reason: 'list-providers-failed', retryable: true }], stale: false, servedFromCache: false, unavailable: true }
    }
    if (!Array.isArray(providers)) providers = []
    for (const raw of providers.slice(0, MAX_PROVIDERS)) {
      const provider = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : '')
      if (provider === '') continue
      const failed = providerFailures.get(provider)
      if (failed !== undefined && at - failed.at < failureTtlMs && !force) {
        failures.push({ provider, reason: failed.reason, retryable: true, cachedFailure: true })
        continue
      }
      try {
        // 有界目录发现：单个 provider 挂死不能拖住其它候选（第一版验收反例：首 provider 不返回 → 整次 snapshot 不返回）。
        const models = await withDeadline(Promise.resolve(llm.listModels(provider)), providerTimeoutMs)
        if (!Array.isArray(models)) throw new Error('listModels did not return an array')
        const seen = new Set()
        let added = 0
        for (const entry of models.slice(0, MAX_MODELS_PER_PROVIDER)) {
          const model = modelIdOf(entry)
          if (model === '' || seen.has(model)) continue      // 同 provider 重复 id 只留一条
          seen.add(model)
          pairs.push({
            provider, model, key: pairKey(provider, model),
            name: typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : model,
            ...(typeof entry === 'object' && entry !== null && typeof entry.description === 'string' ? { description: entry.description } : {}),
            ...(typeof entry === 'object' && entry !== null && Array.isArray(entry.inputModalities) ? { inputModalities: entry.inputModalities.filter((m) => typeof m === 'string') } : {}),
            order: pairs.length,
          })
          added++
        }
        providerFailures.delete(provider)
        if (added === 0) failures.push({ provider, reason: 'no-models', retryable: false })
      } catch (e) {
        // **失败隔离**：只影响该 provider，其它 provider 的候选照常可用。
        const reason = typeof e === 'object' && e !== null && typeof e.code === 'string' ? e.code : 'list-models-failed'
        providerFailures.set(provider, { at, reason })
        failures.push({ provider, reason, retryable: true })
      }
    }
    cache = { at, pairs, failures }
    return { at, pairs, failures, stale: false, servedFromCache: false }
  }

  /** 解析单 pair 能力（有界缓存；失败**不**缓存成永久未知）。 */
  const resolveInfo = async (provider, model) => {
    const key = pairKey(provider, model)
    const at = now()
    const hit = infoCache.get(key)
    if (hit !== undefined && at - hit.at < ttlMs) return { ok: true, info: hit.info, capability: hit.capability }
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return { ok: false, reason: 'llm-unavailable' }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const capability = capabilityOf(info)
      infoCache.set(key, { at, info, capability })
      // 有界：最多 512 条
      if (infoCache.size > 512) infoCache.delete(infoCache.keys().next().value)
      return { ok: true, info, capability }
    } catch (e) {
      const reason = typeof e === 'object' && e !== null && typeof e.code === 'string' ? e.code : 'resolve-model-info-failed'
      return { ok: false, reason }
    }
  }

  return { snapshot, resolveInfo, invalidate, _cache: () => cache }
}

/** 名称提示（可解释，不当作质量/价格承诺）：fast/pro 在模型名上的弱信号。 */
const nameHints = (model) => {
  const id = String(model).toLowerCase()
  const hints = []
  if (/flash|lite|fast|mini|light|small/.test(id)) hints.push('fast')
  if (/pro|max|ultra|large|reason/.test(id)) hints.push('pro')
  return hints
}
const isDeepSeek = (provider) => /deepseek/i.test(String(provider))
/** DeepSeek 偏好同时看 provider 与**模型 id/name**（自定义 provider 下的 DeepSeek 模型也要优先）。 */
const isDeepSeekPair = (pair) => /deepseek/i.test(String(pair.provider)) || /deepseek/i.test(String(pair.model)) || /deepseek/i.test(String(pair.name === undefined ? '' : pair.name))

/**
 * 初次选择：先满足用户显式约束与真实能力，再按 DeepSeek 偏好 + 任务类型 + 名称提示排序。
 * 返回稳定形态，绝不静默选错：未知/歧义 → 明确 reason + candidates。
 * `needs.excludeKeys` / `excludeKey`：已选中的 pair 不重复进入备选池。
 */
export const selectRoute = async ({ catalog, request = {}, resolveInfo }) => {
  if (catalog === undefined || catalog === null) return { ok: false, reason: 'catalog-unavailable' }
  const snap = await catalog.snapshot()
  const mode = ROUTE_MODES.includes(request.mode) ? request.mode : 'auto'
  const failures = snap.failures || []
  const needs = request.needs !== null && typeof request.needs === 'object' ? request.needs : {}

  /** 候选排序（auto/fast/pro 与 exact 的备选池共用同一套能力过滤与偏好）。 */
  const rank = async ({ excludeKey } = {}) => {
    const scored = []
    for (const pair of snap.pairs) {
      if (excludeKey !== undefined && pair.key === excludeKey) continue
      const info = resolveInfo !== undefined ? await resolveInfo(pair.provider, pair.model) : { ok: false, reason: 'no-resolver' }
      // 已证不可用（结构化解析失败码）：**排除**候选，绝不降级成"未知能力"再送进准备期失败。
      if (info.ok !== true && typeof info.reason === 'string' && UNRESOLVABLE_CAPABILITY_CODES.has(info.reason)) {
        scored.push({ pair, rejected: 'capability-unresolvable:' + info.reason, reasons: ['capability-unresolvable'] })
        continue
      }
      const cap = info.ok === true ? info.capability : { known: false, unresolvedReason: info.reason }
      const reasons = []
      let rejected = null
      if (Array.isArray(needs.inputModalities) && needs.inputModalities.length > 0) {
        if (Array.isArray(cap.inputModalities)) {
          const missing = needs.inputModalities.filter((m) => !cap.inputModalities.includes(m))
          if (missing.length > 0) rejected = 'modality-unsupported'
        } else if (needs.requireKnownCapabilities === true) rejected = 'modality-unknown'
      }
      if (rejected === null && Number.isFinite(needs.contextWindow) && Number.isFinite(cap.contextWindow) && cap.contextWindow < needs.contextWindow) rejected = 'context-too-small'
      if (rejected === null && typeof needs.effort === 'string' && Array.isArray(cap.efforts) && !cap.efforts.includes(needs.effort)) rejected = 'effort-unsupported'
      if (rejected !== null) { scored.push({ pair, rejected, reasons: [rejected] }); continue }
      let score = 0
      if (isDeepSeekPair(pair)) { score += 100; reasons.push('deepseek-preferred') }
      const hints = nameHints(pair.model)
      if (mode === 'fast' && hints.includes('fast')) { score += 20; reasons.push('fast-hint') }
      if (mode === 'pro' && hints.includes('pro')) { score += 20; reasons.push('pro-hint') }
      if (request.taskKind === 'review' && /pro|max|reason/.test(String(pair.model).toLowerCase())) { score += 5; reasons.push('review-prefers-stronger-name') }
      if (cap.known !== true) reasons.push('capability-unknown')
      scored.push({ pair, score, reasons, order: pair.order, capability: cap })
    }
    const usable = scored.filter((s) => s.rejected === undefined).sort((a, b) => (b.score - a.score) || (a.order - b.order))
    return { scored, usable }
  }

  /** exact：也要给出**备选池**（显式 modelFallback:true 才有池可用；默认空池=固定）。 */
  const poolFor = async (pair) => {
    if (request.allowFallback === false) return []
    const ranked = await rank({ excludeKey: pair.key })
    return ranked.usable.slice(0, 3).map((s) => ({ provider: s.pair.provider, model: s.pair.model, score: s.score, key: s.pair.key }))
  }

  if (mode === 'inherit') {
    // default（继承）：不覆盖当前选择；若调用方**显式**允许 fallback，则预先算好"失败时可用"的池
    // （首 attempt 用机器实际配置，失败后才有备选可用）。
    if (request.allowFallback !== true) return { ok: true, mode, inherit: true, reason: 'explicit-inherit' }
    const ranked = await rank()
    return {
      ok: true, mode, inherit: true, reason: 'inherit-with-fallback-pool', initial: null,
      alternatives: ranked.usable.slice(0, 3).map((s) => ({ provider: s.pair.provider, model: s.pair.model, score: s.score, key: s.pair.key })),
      failures,
    }
  }

  // 精确指定：provider+model 必须都在目录内（未给 provider 且同名歧义 → 拒绝并给候选）
  if (mode === 'exact' || (typeof request.model === 'string' && request.model !== '')) {
    const model = typeof request.model === 'string' ? request.model : ''
    if (model === '') return { ok: false, reason: 'model-required' }
    if (typeof request.provider === 'string' && request.provider !== '') {
      const hit = snap.pairs.find((p) => p.provider === request.provider && p.model === model)
      if (hit === undefined) {
        const sameModel = snap.pairs.filter((p) => p.model === model)
        return { ok: false, reason: 'exact-pair-not-in-catalog', provider: request.provider, model, candidates: sameModel }
      }
      return { ok: true, mode: 'exact', pair: hit, reason: 'exact-pair', alternatives: await poolFor(hit), failures }
    }
    const matches = snap.pairs.filter((p) => p.model === model)
    if (matches.length === 0) return { ok: false, reason: 'model-not-in-catalog', model, candidates: [] }
    if (matches.length > 1) {
      // 同名跨 provider：**不静默合并**，要求调用方给出 provider
      return { ok: false, reason: 'model-ambiguous-across-providers', model, candidates: matches }
    }
    return { ok: true, mode: 'exact', pair: matches[0], reason: 'exact-model-unique', alternatives: await poolFor(matches[0]), failures }
  }

  // auto/fast/pro：按能力过滤 + 偏好排序
  const { scored, usable } = await rank()
  if (usable.length === 0) {
    return {
      ok: false, mode, reason: 'no-compatible-candidate',
      rejected: scored.filter((s) => s.rejected !== undefined).slice(0, 10).map((s) => ({ provider: s.pair.provider, model: s.pair.model, rejected: s.rejected })),
      failures,
    }
  }
  const best = usable[0]
  // 目录列了但 pair 无法解析能力时的诚实标注（不是"已验证可调用"）
  return {
    ok: true, mode, pair: best.pair, reason: best.reasons.includes('deepseek-preferred') ? 'deepseek-preferred' : (best.reasons[0] || 'stable-order'),
    reasons: best.reasons, capabilityKnown: best.capability !== undefined && best.capability.known === true,
    alternatives: usable.slice(1, 4).map((s) => ({ provider: s.pair.provider, model: s.pair.model, score: s.score })),
    failures, catalogAt: snap.at,
  }
}

/** 失败分类：只用稳定 code/status。 */
export const classifyFailure = (failure) => {
  const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  const status = failure !== null && typeof failure === 'object' && Number.isFinite(failure.status) ? failure.status : undefined
  const retryAfterMs = failure !== null && typeof failure === 'object' && Number.isFinite(failure.providerRetryAfterMs) ? failure.providerRetryAfterMs : undefined
  if (code !== '') {
    if (NEVER_SWITCH_CODES.has(code)) return { action: 'never', code, reason: 'not-a-model-availability-failure' }
    if (SWITCHABLE_CODES.has(code)) return { action: 'switch', code, reason: 'structured-unavailable' }
    if (RETRYABLE_CODES.has(code)) return { action: 'retry-then-switch', code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'transient' }
    // HTTP_404：只说明该路由不可用，**不断言**模型下架
    if (/^HTTP_4\d\d$/.test(code)) return { action: code === 'HTTP_404' || code === 'HTTP_401' || code === 'HTTP_403' || code === 'HTTP_402' ? 'switch' : 'never', code, reason: code === 'HTTP_404' ? 'route-unavailable' : 'request-rejected' }
    if (/^HTTP_5\d\d$/.test(code)) return { action: 'retry-then-switch', code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'server' }
    return { action: 'never', code, reason: 'unknown-code' }              // 未知 code：不切（可能是插件 bug）
  }
  if (status !== undefined) {
    if (status === 401 || status === 403 || status === 402 || status === 404) return { action: 'switch', code: 'HTTP_' + status, reason: 'structured-unavailable' }
    if (status === 429) return { action: 'retry-then-switch', code: 'HTTP_429', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'rate-limit' }
    if (status >= 500) return { action: 'retry-then-switch', code: 'HTTP_' + status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'server' }
    return { action: 'never', code: 'HTTP_' + status, reason: 'request-rejected' }
  }
  return { action: 'never', code: '', reason: 'no-structured-failure' }
}

/** 有界切换策略默认值。 */
export const DEFAULT_ROUTE_LIMITS = {
  maxCandidates: 3,        // 含首次
  maxAttemptsPerPair: 2,
  perPairTimeoutMs: 120_000,
  totalTimeoutMs: 300_000,
  cooldownMs: 30_000,
}

/**
 * 任务作用域的有界切换状态机（同一 taskId/turn/step 内使用；不重派 prompt、不新建 child）。
 * `next()` 只回答"这一次 attempt 用什么 pair / 是否还能继续"，绝不做任何 SDK 副作用。
 *
 * **预算语义（第 55 轮修正）**：`totalTimeoutMs`/`perPairTimeoutMs` 是**故障恢复预算**，
 * 从"恢复 episode"（第一次故障）开始计时，**不**从建任务时计时——否则长健康任务会把预算耗光，
 * 五分钟后的首次故障无法切换。恢复成功（下一 step/turn 的 attempt 未经过失败）会关闭 episode；
 * 下次故障重新开 episode。retry-after 等待走真实时钟，自然计入恢复预算（不会每次 retry 重置）。
 */
export const createRouteSession = (options = {}) => {
  const limits = { ...DEFAULT_ROUTE_LIMITS, ...(options.limits || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const cooldowns = options.cooldowns instanceof Map ? options.cooldowns : new Map()
  const startedAt = now()
  /** 入参 pair 可能只有 {provider,model}：**一律归一化**出 key（否则 attempted/cooldowns 会以 undefined 为键）。 */
  const normalize = (pair) => {
    if (pair === null || pair === undefined) return null
    if (typeof pair.provider !== 'string' || typeof pair.model !== 'string') return null
    return pairOf(pair.provider, pair.model)
  }
  let current = normalize(options.initial)
  const attempted = new Map()          // pairKey → attempts
  const usedOrder = []                 // 已尝试过的 pair（按顺序，去重）
  const switches = []
  let lastFailure = null
  let lastFailureAt = null             // 最近一次失败时刻（用于判断"恢复是否已成功"）
  /** 当前恢复 episode：第一次故障开启；恢复成功后关闭。null = 尚未进入恢复。 */
  let episodeStartedAt = null
  /** 本 episode 内每个 pair 首次故障的时刻（perPairTimeout 的真实消费者）。 */
  const pairRecoveryAt = new Map()
  /** 上一次 attempt 的 turn/step（判断"健康推进"用）。 */
  let lastAttempt = null
  let remaining = Array.isArray(options.alternatives) ? options.alternatives.map(normalize).filter((p) => p !== null) : []

  const closeEpisode = () => { episodeStartedAt = null; pairRecoveryAt.clear(); lastFailureAt = null }

  const pairCooldown = (pair) => {
    const until = cooldowns.get(pair.key)
    return Number.isFinite(until) && until > now() ? until : 0
  }
  const addCooldown = (pair, ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return
    cooldowns.set(pair.key, now() + Math.min(ms, 10 * 60_000))
  }
  const distinctCount = () => usedOrder.length

  /**
   * 记录一次 attempt 的实际使用（由 bridge 在 agent/request 返回前调用）。
   * `position` 可选 `{turn, step}`：若上一 attempt 之后**没有失败**且 turn/step 前进 → 说明上一 attempt
   * 已成功、任务健康推进 → 关闭恢复 episode（下次故障重新获得完整恢复预算）。
   */
  const recordAttempt = (pair, position) => {
    const normalized = normalize(pair)
    if (normalized === null) return
    const turn = position !== null && typeof position === 'object' && Number.isInteger(position.turn) ? position.turn : undefined
    const step = position !== null && typeof position === 'object' && Number.isInteger(position.step) ? position.step : undefined
    // 位置前进 = 上一 attempt 真的产出了内容（step/turn 推进），说明恢复已成功 → 关闭 episode。
    // 注意：**不能**再要求 lastFailureAt===null —— 恢复过程里必然有失败，正是"失败后位置前进"才算恢复成功；
    // 同 turn/step 的重试/切换不会推进位置，因此不会误关。
    if (lastAttempt !== null && Number.isInteger(turn) && Number.isInteger(step) && Number.isInteger(lastAttempt.turn) && Number.isInteger(lastAttempt.step)) {
      const progressed = turn > lastAttempt.turn || (turn === lastAttempt.turn && step > lastAttempt.step)
      if (progressed) closeEpisode()
    }
    const count = (attempted.get(normalized.key) || 0) + 1
    attempted.set(normalized.key, count)
    if (!usedOrder.some((p) => p.key === normalized.key)) usedOrder.push(normalized)
    current = normalized
    lastAttempt = { turn, step }
  }

  /**
   * 收到结构化失败后决定下一步。返回：
   *  { action:'retry', pair, reason }    → 同 turn/step 重试（可能是同 pair 有界重试，也可能是切换后的新 pair）
   *  { action:'stop', reason, exhausted } → 如实失败（不 done、不空输出、不重派）
   */
  const onFailure = (failure, context = {}) => {
    const classified = classifyFailure(failure)
    lastFailure = classified
    const at = now()
    if (context.aborted === true) return { action: 'stop', reason: 'aborted', exhausted: false }
    if (classified.action === 'never') return { action: 'stop', reason: classified.reason, code: classified.code, exhausted: false }
    // ---- 恢复 episode：第一次故障开启；只算**恢复活动**时长，不算任务健康运行时长 ----
    if (episodeStartedAt === null) episodeStartedAt = at
    lastFailureAt = at
    const currentPair = current
    if (currentPair !== null && !pairRecoveryAt.has(currentPair.key)) pairRecoveryAt.set(currentPair.key, at)
    // 总恢复预算（含 retry-after 等待的真实时间）
    if (at - episodeStartedAt >= limits.totalTimeoutMs) return { action: 'stop', reason: 'total-time-limit', exhausted: true }
    // 单 pair 恢复时限：该 pair 在本次恢复 episode 里已耗掉 perPairTimeoutMs → 不再重试它
    const pairStart = currentPair === null ? null : pairRecoveryAt.get(currentPair.key)
    const pairTimeUp = currentPair !== null && Number.isInteger(pairStart) && (at - pairStart >= limits.perPairTimeoutMs)
    // 1) 同一 pair 的有界重试（限流/网络/服务端），且该 pair 的恢复时限未到
    if (classified.action === 'retry-then-switch' && currentPair !== null && !pairTimeUp) {
      const used = attempted.get(currentPair.key) || 0
      if (used < limits.maxAttemptsPerPair) {
        return { action: 'retry', pair: currentPair, reason: 'bounded-retry:' + classified.reason, ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }) }
      }
    }
    // 2) 切换到下一个不同候选（perPair 时限到/该 pair 次数用完/结构化不可用都走这里）
    if (classified.action === 'switch' || classified.action === 'retry-then-switch') {
      if (currentPair !== null) addCooldown(currentPair, classified.retryAfterMs !== undefined ? classified.retryAfterMs : limits.cooldownMs)
      if (distinctCount() >= limits.maxCandidates) return { action: 'stop', reason: 'candidate-limit', exhausted: true }
      while (remaining.length > 0) {
        const candidate = remaining.shift()
        if (attempted.has(candidate.key)) continue            // 不重复选已失败候选（不绕圈）
        const until = pairCooldown(candidate)
        if (until > at) continue                              // 临时冷却中的不选
        switches.push({ at, from: currentPair === null ? null : { provider: currentPair.provider, model: currentPair.model }, to: { provider: candidate.provider, model: candidate.model }, code: classified.code, reason: pairTimeUp ? 'per-pair-time-limit' : classified.reason })
        current = candidate
        return { action: 'retry', pair: candidate, reason: pairTimeUp ? 'switch:per-pair-time-limit' : 'switch:' + classified.reason, switched: true }
      }
      return { action: 'stop', reason: 'candidates-exhausted', exhausted: true }
    }
    return { action: 'stop', reason: classified.reason, code: classified.code, exhausted: false }
  }

  const summary = () => ({
    attempts: attempted.size,
    uses: Array.from(attempted.entries()),
    switches: switches.length,
    switchLog: switches.slice(0, 20),
    lastFailure,
    initial: options.initial === undefined ? null : options.initial,
    current: current === null ? null : { provider: current.provider, model: current.model },
    /** 任务存活时长（仅诊断；**不**参与恢复预算）。 */
    elapsedMs: now() - startedAt,
    /** 当前恢复 episode 已用时长（没有 episode 时为 0）。 */
    recoveryElapsedMs: episodeStartedAt === null ? 0 : now() - episodeStartedAt,
    episodeOpen: episodeStartedAt !== null,
  })

  return { recordAttempt, onFailure, summary, limits, _state: () => ({ attempted, usedOrder, remaining }) }
}

/** 供审计/状态回显使用的非秘密摘要。 */
export const routeSummaryOf = (session) => (session === null || session === undefined ? null : session.summary())
