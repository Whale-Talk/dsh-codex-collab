/**
 * 手工入口（**不在 `test/*.test.mjs` 自动回归里**）：真实官方 worker 生命周期的本机验证。
 *
 * 为什么不在自动回归：它依赖 Root 的 `runtime-fixture.mjs`（组合真实 SubagentRuntime /
 * SpawnInProcessProvider / JsonlSessionPersistence / SessionQueryEngine 的大型夹具，属 Root 私有
 * 评审目录），公共仓库无法把它当可移植回归；本脚本因此**不计数**、也不在无人配置时"默默通过"。
 *
 * 用法（Root 环境）：
 *   DSH_ROUTING_NATIVE_FIXTURE=<...>/model-routing-native-review/runtime-fixture.mjs \
 *   node test/manual/model-routing-worker-native.mjs
 * 未设置该变量 → 打印说明并以 exit 2 结束（诚实的"未运行"，不是 pass）。
 *
 * 断言覆盖：同一 durable child 的**连续任务 + 自然释放后 cold 恢复**；每个 epoch 的 live agent；
 * turn 严格递增；每任务模型策略真实生效；已执行 nonce 工具结果（**同 callId 的 tool/result**）恰一次；
 * 不新建 child 冒充继续。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.resolve(HERE, '..', '..', 'harness', 'dsh-bridge.mjs')
const FIXTURE = process.env.DSH_ROUTING_NATIVE_FIXTURE === undefined ? '' : process.env.DSH_ROUTING_NATIVE_FIXTURE

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeout = 25000) => { const end = Date.now() + timeout; for (;;) { const r = await fn(); if (r) return r; if (Date.now() > end) throw new Error('timed out'); await sleep(15) } }

async function run() {
  const { createNativeFixture } = await import(pathToFileURL(FIXTURE).href)
  let f = null
  let failure = null
  try {
    f = await createNativeFixture({
      name: 'model-routing-worker-continuous',
      nativeWorkers: true,
      onRequest: async ({ record, fixture }) => {
        const agent = fixture.ctx.agents.get(record.agentId)
        if (agent === undefined || agent.session.header.parentSession === undefined) return [{ type: 'text', text: 'ROOT_IDLE_SUCCESS' }]
        if (record.turn === 1) {
          if (record.step === 1) return [{ type: 'tool-call', id: 'call-nonce-1', name: 'write_once_nonce', arguments: JSON.stringify({ nonce: fixture.nonce }) }]
          return [{ type: 'text', text: 'WORKER_TURN1_DONE' }]
        }
        if (record.turn === 2) return [{ type: 'text', text: 'WORKER_TURN2_CONTINUATION_DONE' }]
        if (record.turn === 3) return [{ type: 'text', text: 'WORKER_TURN3_COLD_DONE' }]
        return [{ type: 'text', text: 'WORKER_TURN_OTHER_' + record.turn }]
      },
    })
    await f.createAgent({ provider: 'backup-offline', model: 'backup' })
    await f.loadHostPlugin(BRIDGE)
    const url = await f.listen()
    const origin = 'worker-continuous-manual'
    const status = async (id) => (await fetch(url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(id) + '&originThreadId=' + origin)).json()
    const dispatch = async (instruction, extra = {}) => {
      const res = await fetch(url + '/api/dsh-bridge/task', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction, cwd: f.workspace, lane: 'worker-continuous', originThreadId: origin, model: 'auto', ...extra }),
      })
      return { statusCode: res.status, body: await res.json() }
    }
    const awaitTask = async (id) => {
      const end = Date.now() + 25000
      let row
      do { row = await status(id); if (['done', 'error', 'cancelled'].includes(row.status)) return row; await sleep(30) } while (Date.now() < end)
      return row
    }

    // ---- 任务 1：新建 durable child（首 claim / 父 owner / 所选模型真实生效 / nonce 恰一次） ----
    const first = await dispatch('first worker turn, keep durable child')
    assert.equal(first.statusCode, 202, JSON.stringify(first.body))
    const childId = first.body.route.expectedChildId
    assert.equal(typeof childId, 'string')
    const firstDone = await awaitTask(first.body.taskId)
    assert.equal(firstDone.status, 'done', JSON.stringify(firstDone))
    assert.equal(firstDone.result, 'WORKER_TURN1_DONE')
    const turn1 = f.requests.filter((r) => r.agentId === childId && r.turn === 1)
    assert.equal(turn1.length > 0, true)
    assert.equal(turn1[0].provider, 'deepseek-offline', '首任务必须用所选 DeepSeek')
    assert.equal(f.toolExecutions, 1, 'nonce 恰一次')

    // ---- 任务 2：等 durable child **自然释放**后的连续任务（cold 恢复；bridge 入口没有 warm 通道） ----
    await until(() => f.ctx.agents.get(childId) === undefined)
    const second = await dispatch('second worker turn, same durable child after natural release', { provider: 'alternate-offline', model: 'alternate', modelFallback: false })
    assert.equal(second.statusCode, 202, JSON.stringify(second.body))
    assert.equal(second.body.route.expectedChildId, childId, '必须继续同一个 durable child')
    const secondDone = await awaitTask(second.body.taskId)
    assert.equal(secondDone.status, 'done', JSON.stringify(secondDone))
    assert.equal(secondDone.result, 'WORKER_TURN2_CONTINUATION_DONE')
    assert.equal(secondDone.fallback, undefined, '不得降级为 one-shot')
    const turn2 = f.requests.filter((r) => r.agentId === childId && r.turn === 2 && r.step === 1)
    assert.equal(turn2.length, 1, '必须在同一个 durable child 上产生 turn 2（不是新 child）')
    assert.equal(turn2[0].provider, 'alternate-offline', '每任务路由策略必须真实生效')
    const noNewChild = f.requests.filter((r) => r.turn === 1 && r.agentId !== childId && !r.agentId.startsWith('dsh-bridge-owner-'))
    assert.equal(noNewChild.length, 0, '不得新建 child 冒充继续: ' + JSON.stringify(noNewChild.map((r) => r.agentId)))

    // ---- 任务 3：第二次自然释放后的 cold 恢复 ----
    await until(() => f.ctx.agents.get(childId) === undefined)
    const beforeCold = f.requests.length
    const third = await dispatch('third worker turn after second natural release', { provider: 'backup-offline', model: 'backup', modelFallback: false })
    assert.equal(third.statusCode, 202, JSON.stringify(third.body))
    const thirdDone = await awaitTask(third.body.taskId)
    assert.equal(thirdDone.status, 'done', JSON.stringify(thirdDone))
    assert.equal(thirdDone.result, 'WORKER_TURN3_COLD_DONE')
    const coldRequests = f.requests.slice(beforeCold).filter((r) => r.agentId === childId)
    assert.equal(coldRequests.length > 0, true, 'cold 恢复必须在同一 durable child 上产生请求')
    assert.equal(coldRequests.every((r) => r.turn === 3), true, 'cold 恢复 turn 必须严格递增为 3: ' + JSON.stringify(coldRequests.map((r) => r.turn)))
    assert.equal(coldRequests[0].provider, 'backup-offline', 'cold 任务的显式策略必须生效')

    // ---- 历史保留：真实会话里**同 callId 的 tool/result** 恰一次（不是只匹配用户原文） ----
    const snapshot = await f.ctx.sessionQuery.readSession(childId)
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const callIdOfResult = (e) => {
      const data = e.data !== null && typeof e.data === 'object' ? e.data : {}
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      if (typeof message.toolCallId === 'string') return message.toolCallId
      if (message.source !== null && typeof message.source === 'object' && typeof message.source.callId === 'string') return message.source.callId
      return undefined
    }
    const nonceResults = events.filter((e) => e.type === 'tool/result' && JSON.stringify(e.data).includes(f.nonce))
    assert.equal(nonceResults.length, 1, 'nonce 工具结果必须恰一次: ' + nonceResults.length)
    const nonceCall = events.find((e) => e.type === 'tool/call' && e.data && e.data.callId === 'call-nonce-1')
    assert.ok(nonceCall, '必须有同 callId 的 tool/call')
    // 官方 tool/result 的形状是 data.message.{toolCallId,source.callId}（不是 data.callId）
    const sameCallResult = events.find((e) => e.type === 'tool/result' && callIdOfResult(e) === 'call-nonce-1')
    assert.ok(sameCallResult, '必须有同 callId 的 tool/result（不是只命中用户原文）')
    assert.equal(JSON.stringify(sameCallResult.data).includes(f.nonce), true, '该 tool/result 必须携带真实 nonce')
    assert.equal(f.toolExecutions, 1, 'nonce 工具必须全程恰好一次（cold 恢复都不重跑历史工具）')

    // ---- 全程：同一 durable child、turn 严格递增 ----
    const childRequests = f.requests.filter((r) => r.agentId === childId)
    assert.deepEqual(childRequests.map((r) => r.turn), [1, 1, 2, 3], '同一 durable child 的回合必须严格递增: ' + JSON.stringify(childRequests.map((r) => [r.turn, r.step, r.provider])))
    const secondAudit = JSON.stringify(secondDone.routeAudit || [])
    assert.equal(secondAudit.includes('"kind":"first-request"'), true, '连续任务审计必须记录真实首请求')
    assert.equal(secondAudit.includes('"attempts":0'), false, '连续任务不得 attempts=0 却 done')
    console.log('[manual] worker 连续任务 + 两次自然 cold 恢复：PASS（同一 durable child / turn 1,2,3 / 每任务模型策略 / nonce 恰一次）')
  } catch (error) {
    failure = error
  } finally {
    if (f !== null) {
      try { await f.close() } catch (closeError) {
        // 清理失败必须让本入口失败（不把自己的残留进程/文件当作成功）
        failure = failure === null ? closeError : new Error(String(failure && failure.message) + ' / cleanup failed: ' + String(closeError && closeError.message))
      }
    }
  }
  if (failure !== null) {
    console.error('[manual] FAIL: ' + (failure && failure.stack ? failure.stack : String(failure)))
    process.exitCode = 1
  }
}

// ---- 入口（放在所有声明之后：避免顶层 await 命中 TDZ）----
if (FIXTURE === '') {
  console.error('[manual] 未配置 DSH_ROUTING_NATIVE_FIXTURE —— 这是 Root 环境的一次性验证入口，不计入仓库回归。')
  process.exitCode = 2
} else if (!fs.existsSync(FIXTURE)) {
  console.error('[manual] 配置了 DSH_ROUTING_NATIVE_FIXTURE 但文件不存在: ' + FIXTURE + ' —— 失败，不静默跳过。')
  process.exitCode = 1
} else {
  await run()
}
