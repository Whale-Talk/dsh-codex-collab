/**
 * 手工入口（**不在 `test/*.test.mjs` 自动回归里**）：真实官方 SDK 下的**评审子代理模型路由**验证。
 *
 * 与 worker 手工入口同一定位：依赖 Root 的 `runtime-fixture.mjs`（44 个官方包的真实组合：
 * SubagentRuntime/SpawnInProcessProvider/JSONL/SessionQuery），公共仓库无法把它当可移植回归；
 * 本脚本不计数，未配置时 exit 2 明确"未运行"（不是 pass），配置但加载失败则失败。
 *
 * 用法（Root 环境）：
 *   DSH_ROUTING_NATIVE_FIXTURE=<...>/model-routing-native-review/runtime-fixture.mjs \
 *   node test/manual/model-routing-review-native.mjs
 *
 * 断言覆盖：
 *   A. 默认 auto：评审首请求真的走 DeepSeek（不是机器基线 backup），route/审计存在且 attempts>0；
 *   B. 结构化故障（AUTH）→ 同 turn/step 有界切换到备选 provider，评审最终成功；
 *   C. nonce 工具**恰好执行一次**，且用**同 callId 的 tool/result**核验（不是只匹配用户原文）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.resolve(HERE, '..', '..', 'harness', 'dsh-bridge.mjs')
const FIXTURE = process.env.DSH_ROUTING_NATIVE_FIXTURE === undefined ? '' : process.env.DSH_ROUTING_NATIVE_FIXTURE
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (FIXTURE === '') {
    console.error('[manual] 未配置 DSH_ROUTING_NATIVE_FIXTURE —— 这是 Root 环境的一次性验证入口，不计入仓库回归。')
    process.exitCode = 2
    return
  }
  if (!fs.existsSync(FIXTURE)) {
    console.error('[manual] 配置了 DSH_ROUTING_NATIVE_FIXTURE 但文件不存在: ' + FIXTURE + ' —— 失败，不静默跳过。')
    process.exitCode = 1
    return
  }
  const { createNativeFixture } = await import(pathToFileURL(FIXTURE).href)
  const origin = '01a100f1-045c-7e10-84c7-ac8ec37eff3f'
  let f = null
  let failure = null
  try {
    let switched = false
    f = await createNativeFixture({
      name: 'model-routing-review-native',
      nativeWorkers: true,
      onRequest: async ({ record }) => {
        // 只关心评审子代理（有父会话的 child）；父 owner 自身回 idle。
        const agent = f.ctx.agents.get(record.agentId)
        if (agent === undefined || agent.session.header.parentSession === undefined) return [{ type: 'text', text: 'ROOT_IDLE_SUCCESS' }]
        if (record.provider === 'deepseek-offline' && record.turn === 1 && record.step === 1 && switched === false) {
          switched = true
          // 结构化可切换失败：AUTH → 同 turn/step 换 provider，不重派 prompt、不重放用户输入
          return { failure: { code: 'AUTH', status: 401 } }
        }
        if (record.turn === 1 && record.step === 1 && record.provider !== 'deepseek-offline') {
          return [{ type: 'tool-call', id: 'call-review-nonce', name: 'write_once_nonce', arguments: JSON.stringify({ nonce: f.nonce }) }]
        }
        return [{ type: 'text', text: 'REVIEW_ROUTED_SUCCESS' }]
      },
    })
    await f.createAgent({ provider: 'backup-offline', model: 'backup' })
    await f.loadHostPlugin(BRIDGE)
    const url = await f.listen()
    const response = await fetch(url + '/api/dsh-bridge/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: f.workspace, diff: 'root harmless offline diff', focus: 'model routing recovery', originThreadId: origin }),
    })
    assert.equal(response.status, 202, '评审派活必须 202')
    const dispatch = await response.json()
    assert.equal(dispatch.kind, 'review')
    assert.deepEqual(dispatch.route.chosen, { provider: 'deepseek-offline', model: 'primary' }, '评审默认 auto 必须选 DeepSeek')
    const taskId = dispatch.taskId
    const deadline = Date.now() + 25000
    let terminal = null
    for (;;) {
      const r = await fetch(url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=' + encodeURIComponent(origin))
      terminal = await r.json()
      if (['done', 'error', 'cancelled'].includes(terminal.status)) break
      if (Date.now() > deadline) throw new Error('review observation deadline')
      await sleep(30)
    }
    assert.equal(terminal.status, 'done', '评审在结构化故障后必须同 turn/step 恢复成功: ' + JSON.stringify(terminal))
    assert.equal(terminal.result, 'REVIEW_ROUTED_SUCCESS')
    assert.equal(terminal.route.chosen.provider, 'deepseek-offline')
    const audit = Array.isArray(terminal.routeAudit) ? terminal.routeAudit : []
    const kinds = audit.map((e) => e.kind)
    assert.equal(kinds.includes('first-request'), true, '评审必须有 first-request 审计: ' + JSON.stringify(kinds))
    assert.equal(kinds.includes('failure'), true, '必须记录结构化故障: ' + JSON.stringify(kinds))
    assert.equal(kinds.includes('switch'), true, '必须记录同 turn/step 的切换: ' + JSON.stringify(kinds))
    const finish = audit.filter((e) => e.kind === 'finish' && e.status === 'done').at(-1)
    assert.ok(finish, '必须有 done 收口审计')
    assert.equal(finish.attempts >= 1, true, '评审 done 不能是 attempts=0: ' + JSON.stringify(finish))
    assert.equal(finish.switches >= 1, true, '评审必须真实发生过切换: ' + JSON.stringify(finish))
    // nonce 恰一次 + 同 callId tool/result
    const childId = dispatch.route.chosen !== null ? audit.find((e) => e.kind === 'first-request-bound')?.agentId : undefined
    assert.equal(typeof childId, 'string', '必须能定位评审 child')
    const liveChild = f.ctx.agents.get(childId)
    if (liveChild !== undefined && liveChild !== null && f.ctx.sessions !== undefined) await f.ctx.sessions.flush(liveChild.session)
    const snapshot = await f.ctx.sessionQuery.readSession(childId)
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const nonceResults = events.filter((e) => e.type === 'tool/result' && JSON.stringify(e.data).includes(f.nonce))
    assert.equal(nonceResults.length, 1, 'nonce 工具结果必须恰一次: ' + nonceResults.length)
    const sameCall = events.find((e) => e.type === 'tool/result' && (
      (e.data?.message?.toolCallId === 'call-review-nonce') || (e.data?.message?.source?.callId === 'call-review-nonce')
    ))
    assert.ok(sameCall, '必须有同 callId 的 tool/result')
    assert.equal(f.toolExecutions, 1, 'nonce 工具必须恰好执行一次')

    // ---- 第二条评审：等评审 child 自然释放后 cold 继续**同一个 durable child**，独立 task/审计/来源 ----
    const deadline2 = Date.now() + 20000
    for (;;) {
      if (f.ctx.agents.get(childId) === undefined) break
      if (Date.now() > deadline2) throw new Error('review child did not release')
      await sleep(20)
    }
    const before2 = f.requests.length
    const second = await fetch(url + '/api/dsh-bridge/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: f.workspace, diff: 'second review diff', originThreadId: origin, provider: 'backup-offline', model: 'backup', modelFallback: false }),
    })
    assert.equal(second.status, 202)
    const dispatch2 = await second.json()
    assert.notEqual(dispatch2.taskId, dispatch.taskId, '第二条评审必须是独立 task')
    assert.equal(dispatch2.originThreadId, origin)
    assert.deepEqual(dispatch2.route.chosen, { provider: 'backup-offline', model: 'backup' })
    let terminal2 = null
    for (;;) {
      const r = await fetch(url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(dispatch2.taskId) + '&originThreadId=' + encodeURIComponent(origin))
      terminal2 = await r.json()
      if (['done', 'error', 'cancelled'].includes(terminal2.status)) break
      if (Date.now() > deadline2) throw new Error('second review deadline')
      await sleep(30)
    }
    assert.equal(terminal2.status, 'done', JSON.stringify(terminal2))
    const secondChildRequests = f.requests.slice(before2).filter((r) => r.agentId === childId)
    assert.equal(secondChildRequests.length > 0, true, '第二条评审必须在同一 durable child 上产生请求')
    assert.equal(secondChildRequests.every((r) => r.turn === 2), true, '同一 durable child 的 turn 必须严格递增为 2: ' + JSON.stringify(secondChildRequests.map((r) => r.turn)))
    assert.equal(secondChildRequests[0].provider, 'backup-offline', '第二条评审的显式策略必须生效')
    const audit2 = Array.isArray(terminal2.routeAudit) ? terminal2.routeAudit : []
    assert.equal(audit2.every((e) => e.taskId === dispatch2.taskId), true, '第二条评审的审计必须独立（只属于它自己的 taskId）')
    assert.equal(audit2.some((e) => e.kind === 'first-request'), true)
    assert.equal(f.toolExecutions, 1, '第二条评审不得重跑历史 nonce 工具')
    console.log('[manual] review 默认路由 + 结构化故障同 turn/step 恢复 + nonce 恰一次：PASS（DeepSeek 首请求 / switch>=1 / attempts>0）')
    console.log('[manual] 第二条评审 cold 继续同一 durable child（turn 2 / 显式 backup / 独立审计 / nonce 仍 1）：PASS')
  } catch (error) {
    failure = error
  } finally {
    if (f !== null) {
      try { await f.close() } catch (closeError) {
        failure = failure === null ? closeError : new Error(String(failure && failure.message) + ' / cleanup failed: ' + String(closeError && closeError.message))
      }
    }
  }
  if (failure !== null) {
    console.error('[manual] FAIL: ' + (failure && failure.stack ? failure.stack : String(failure)))
    process.exitCode = 1
  }
}

await main()
