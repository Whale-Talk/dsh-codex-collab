/**
 * 投递模式**首次验收修正**行为回归（A–F）。
 * 逐条镜像 Root/独立 explorer 的两份只读报告：
 *   probe-delivery-receipts-review.mjs → delivery-receipts-review-report.json
 *   probe-delivery-owners.mjs         → delivery-owner-probe.json
 * 跑法: node test/delivery-acceptance-fixes.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disposeAll, makeTmp, startGateway, runCli, runMcp, mcpInit, mcpCall, payloadOf } from './helpers/dsh-host.mjs'
import { initControlKey } from '../harness/codex-approvals.mjs'
import { openAssociations } from '../harness/codex-associations.mjs'
import { createRequestTracker, consumeSessionEvent } from '../harness/session-target.mjs'

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvfix-key-'))
const keyPath = path.join(keyDir, 'control.key')
initControlKey({ path: keyPath })
const HEADERS = { 'X-Dsh-Control': fs.readFileSync(keyPath, 'utf8').trim() }
process.env.DSH_APPROVAL_CONTROL_KEY_PATH = keyPath

after(async () => {
  delete process.env.DSH_APPROVAL_CONTROL_KEY_PATH
  await disposeAll()
  try { fs.rmSync(keyDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})

const lastJsonLine = (stdout) => {
  for (const line of stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).reverse()) {
    try { return JSON.parse(line) } catch (e) { /* 继续找上一条 */ }
  }
  return null
}

const ev = (seq, type, data) => ({ seq, type, data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const getJson = async (url, headers) => {
  const res = await fetch(url, { headers })
  let body = null
  try { body = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body }
}
const postJson = async (url, payload, headers) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(payload) })
  let body = null
  try { body = await res.json() } catch (e) { /* non-JSON */ }
  return { status: res.status, body }
}
const until = async (fn, { timeoutMs = 6000, intervalMs = 40 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
const setup = async (env = {}) => {
  const assocRoot = await makeTmp('dlvfix-assoc-')
  const storeRoot = await makeTmp('dlvfix-store-')
  const events = []
  const gateway = await startGateway({ assocRoot, events, env: { DSH_APPROVAL_DIR: storeRoot, ...env } })
  return {
    gateway, events, assocRoot,
    cliEnv: { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath },
    mcpEnv: { DSH_BRIDGE_URL: gateway.url, DSH_APPROVAL_CONTROL_KEY_PATH: keyPath },
    push: (...items) => { for (const item of items) events.push(ev(events.length + 1, item[0], item[1])) },
  }
}
const statusOf = async (gateway, taskId, origin = 'owner') => {
  const res = await getJson(gateway.url + '/api/dsh-bridge/status?taskId=' + encodeURIComponent(taskId) + '&originThreadId=' + encodeURIComponent(origin))
  return res.status === 200 && res.body !== null && typeof res.body === 'object' ? res.body : { httpStatus: res.status, ...(res.body || {}) }
}
/** 派一条来源绑定的父任务并让它真正进入 running。 */
const startParent = async (env, { sessionId = 'sess-fix', origin = 'owner', turn = 1 } = {}) => {
  const res = await postJson(env.gateway.url + '/api/dsh-bridge/task', { instruction: 'parent', sessionId, originThreadId: origin, deliver: 'queue' })
  assert.equal(res.status, 202, JSON.stringify(res.body))
  env.push(['turn/start', { turn }], ['user/message', { id: 'u-parent', role: 'user', content: [{ type: 'text', text: 'go' }], source: { rpcId: res.body.taskId } }])
  env.gateway.emitCtx('api-session/status', sessionId, true)
  const running = await until(async () => {
    await env.gateway.runIntervals()
    return (await statusOf(env.gateway, res.body.taskId, origin)).status === 'running'
  })
  assert.equal(running, true, '父任务必须能进入 running')
  return res.body.taskId
}
const steer = (env, body, headers = HEADERS) => postJson(env.gateway.url + '/api/dsh-bridge/task', { deliver: 'steer', originThreadId: 'owner', ...body }, headers)

// ================================================================ A 持久回执链路

test('A 回执链路贯通：父关系/投递模式/回执证据执行前落盘；重启保留"自身已observed"而父执行可 unknown', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '2000' })
  const { gateway, assocRoot } = env
  const sessionId = 'sess-fix'
  try {
    const parentTaskId = await startParent(env, { sessionId })
    const receipt = await steer(env, { instruction: 'receipt', sessionId, parentTaskId, expectedTurn: 1 })
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body))
    // 执行前就已落盘（bind 不可变关系）：此时还未观察到自身 rpcId
    const store = openAssociations({ root: assocRoot, namespace: process.env.DSH_BRIDGE_ASSOC_NAMESPACE || 'default' })
    const bound = store.fetch({ originThreadId: 'owner', taskId: receipt.body.taskId })
    assert.equal(bound.ok, true, JSON.stringify(bound))
    assert.equal(bound.record.deliver, 'steer', '投递模式必须落盘: ' + JSON.stringify(bound.record))
    assert.equal(bound.record.parentTaskId, parentTaskId, '不可变父关系必须落盘')
    assert.equal(bound.record.resultScope, 'parent-task')
    assert.equal(bound.record.receiptState, 'accepted')
    // 观察到自身 rpcId
    env.push(['user/message', { id: 'u-receipt', role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: receipt.body.taskId } }])
    const observed = await until(async () => {
      const st = await statusOf(gateway, receipt.body.taskId)
      return st.receiptState === 'observed' ? st : false
    })
    assert.notEqual(observed, false, '回执必须被观察到')
    assert.equal(observed.observedTurn, 1)
    assert.equal(observed.resultScope, 'parent-task')
    const storedObserved = store.fetch({ originThreadId: 'owner', taskId: receipt.body.taskId })
    assert.equal(storedObserved.record.receiptState, 'observed', '回执证据必须落盘: ' + JSON.stringify(storedObserved.record))
    assert.equal(storedObserved.record.observedTurn, 1)
    assert.equal(storedObserved.record.result, undefined, '回执落盘记录不得有父结果')
    // 来源清单视图也必须带父/回执字段
    const list = await getJson(gateway.url + '/api/dsh-bridge/status?originThreadId=owner')
    const listed = list.body.tasks.find((t) => t.taskId === receipt.body.taskId)
    assert.equal(listed.deliver, 'steer', '清单视图必须带 deliver: ' + JSON.stringify(listed))
    assert.equal(listed.parentTaskId, parentTaskId)
    assert.equal(listed.receiptState, 'observed')
    assert.equal(listed.observedTurn, 1)
    assert.equal(listed.resultScope, 'parent-task')
  } finally {
    await gateway.close()
  }
  // 重启（新实例、同一 assoc 根）：自身的 observed 是持久事实，父执行状态可以是 unknown
  const second = await startGateway({ assocRoot, events: [], env: { DSH_APPROVAL_DIR: path.join(assocRoot, 'approvals') } })
  try {
    const recovered = await statusOf(second, receiptTaskIdOf(assocRoot))
    // 通过清单找回收据（新实例没有内存任务）
    const listed = await getJson(second.url + '/api/dsh-bridge/status?originThreadId=owner')
    const receiptRow = listed.body.tasks.find((t) => t.deliver === 'steer')
    assert.notEqual(receiptRow, undefined, '重启后回执记录必须仍在: ' + JSON.stringify(listed.body.tasks))
    assert.equal(receiptRow.receiptState, 'observed', '重启后不得把已观察回执降级: ' + JSON.stringify(receiptRow))
    assert.equal(receiptRow.status, 'receipt-observed', '重启后状态必须仍是 receipt-observed')
    assert.equal(receiptRow.observedTurn, 1)
    assert.equal(receiptRow.resultScope, 'parent-task')
    assert.equal(receiptRow.parentTaskId !== undefined, true)
    // 父任务：没执行完成证据 → unknown（不谎报 done），且不重发
    const parentRow = listed.body.tasks.find((t) => t.deliver !== 'steer')
    assert.equal(parentRow.status, 'unknown', '父任务在新实例里只能是 unknown: ' + JSON.stringify(parentRow))
    assert.equal(parentRow.resend, false)
    assert.equal(second.prompts.length, 0, '重启不得重发任何东西')
    // 错来源仍然拒绝
    const wrong = await statusOf(second, receiptRow.taskId, 'someone-else')
    assert.equal(wrong.httpStatus, 404, '错来源必须拒绝: ' + JSON.stringify(wrong))
    assert.equal(wrong.reason, 'origin-mismatch')
  } finally {
    await second.close()
  }
})

/** 从 assoc 根读回"那条回执"的 taskId（重启场景用）。 */
const receiptTaskIdOf = (assocRoot) => {
  const dir = path.join(assocRoot)
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const text = fs.readFileSync(full, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const value = JSON.parse(trimmed)
          if (value !== null && typeof value === 'object' && value.type === 'bind' && value.deliver === 'steer') found.push(value.taskId)
        } catch (e) { /* ignore */ }
      }
    }
  }
  walk(dir)
  return found[0]
}

// ================================================================ B fresh 预检 + 已接收竞态

test('B 父回合 fresh 预检：官方日志已 A end + B start → 零 prompt 拒绝；预检后竞态不假成功（deviated + 真 observedTurn）', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway } = env
  const sessionId = 'sess-fix'
  try {
    const parentTaskId = await startParent(env, { sessionId, turn: 1 })
    // 官方日志证据：父 turn1 已 end，且有新 turn2 开始（Root: "父tracker旧running，但官方日志已有A end+B start"）
    env.push(['turn/end', { turn: 1, reason: { kind: 'completed' } }], ['turn/start', { turn: 2 }])
    const before = gateway.prompts.length
    const refused = await steer(env, { instruction: 'too-late', sessionId, parentTaskId })
    assert.notEqual(refused.status, 202, '父回合已结束且有新回合 → 必须执行前拒绝: ' + JSON.stringify(refused.body))
    assert.equal(refused.body.reason, 'steer-parent-turn-closed', '必须给出明确的回合关闭原因: ' + JSON.stringify(refused.body))
    assert.equal(gateway.prompts.length, before, '被拒的 steer 必须零 prompt')

    // 预检通过后的竞态：父 turn10 开放 → 接收；随后自身 rpc 落进 turn11 → 如实偏离，不假成功
    const parent2 = await startParent(env, { sessionId: 'sess-race', turn: 10 })
    const accepted = await steer(env, { instruction: 'race', sessionId: 'sess-race', parentTaskId: parent2, expectedTurn: 10 })
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
    env.push(
      ['turn/end', { turn: 10, reason: { kind: 'completed' } }],
      ['turn/start', { turn: 11 }],
      ['user/message', { id: 'u-race', role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: accepted.body.taskId } }],
    )
    const outcome = await until(async () => {
      const st = await statusOf(gateway, accepted.body.taskId)
      return st.receiptState === 'deviated' || st.receiptState === 'unconfirmed' || st.receiptState === 'observed' ? st : false
    }, { timeoutMs: 8000 })
    assert.notEqual(outcome, false, '必须给出回执结论')
    assert.notEqual(outcome.receiptState, 'observed', '落进另一个回合绝不能标成 observed（假成功）: ' + JSON.stringify(outcome))
    assert.equal(outcome.receiptState, 'deviated', '必须如实报告偏离: ' + JSON.stringify(outcome))
    assert.equal(outcome.observedTurn, 11, 'observedTurn 必须是真实落点')
    assert.equal(outcome.reason, 'steer-turn-deviated')
    assert.equal(outcome.resend, false, '偏离也不重发')
    assert.equal(gateway.prompts.filter((p) => p.requestId === accepted.body.taskId).length, 1, '只投递一次')
  } finally {
    await gateway.close()
  }
})

// ================================================================ C 回执生命周期 + 客户端

test('C 回执不进通用执行收口：父文本/turn-end 不得把回执标 done 或残留父结果；MCP/CLI 只等回执自身终态', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway, assocRoot } = env
  const sessionId = 'sess-fix'
  try {
    const parentTaskId = await startParent(env, { sessionId, turn: 1 })
    const receipt = await steer(env, { instruction: 'S', sessionId, parentTaskId })
    assert.equal(receipt.status, 202)
    // 追加：自身 rpc + 父的助手文本 + 父 turn/end，然后触发一次**真实 sweep**（Root 正是在 sweep 里被抢结算）
    env.push(
      ['user/message', { id: 'u-c', role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: receipt.body.taskId } }],
      ['assistant/message', { turn: 1, step: 1, message: { id: 'a-parent', role: 'assistant', content: [{ type: 'text', text: 'PARENT_RESULT_SENTINEL' }] } }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    )
    gateway.emitCtx('api-session/status', sessionId, true)
    await gateway.runIntervals()
    const after = await statusOf(gateway, receipt.body.taskId)
    assert.notEqual(after.status, 'done', '回执绝不能被 sweep 抢结算成 done: ' + JSON.stringify(after))
    assert.equal(after.result, undefined, '回执绝不承载父结果（内存视图）: ' + JSON.stringify(after))
    assert.equal(after.receiptState, 'observed')
    assert.equal(after.observedTurn, 1)
    const store = openAssociations({ root: assocRoot, namespace: process.env.DSH_BRIDGE_ASSOC_NAMESPACE || 'default' })
    const stored = store.fetch({ originThreadId: 'owner', taskId: receipt.body.taskId })
    assert.notEqual(stored.record.result, 'PARENT_RESULT_SENTINEL', '落盘记录也不能残留父结果: ' + JSON.stringify(stored.record))
    assert.equal(stored.record.result, undefined)
    assert.equal(stored.record.receiptState, 'observed')
    // 父任务自己仍然是它自己的结果归属（等它的 turn/end 收口）
    const parentView = await until(async () => {
      await gateway.runIntervals()
      const st = await statusOf(gateway, parentTaskId)
      return st.status === 'done' ? st : false
    })
    assert.notEqual(parentView, false, '父任务必须自己收口为 done')
    assert.equal(parentView.result, 'PARENT_RESULT_SENTINEL', '父结果归父任务')
    // 再触发几次 sweep + 共享 status：回执仍不得被改写
    gateway.emitCtx('api-session/status', sessionId, false)
    await gateway.runIntervals()
    await gateway.runIntervals()
    const steady = await statusOf(gateway, receipt.body.taskId)
    assert.equal(steady.status, 'receipt-observed')
    assert.equal(steady.result, undefined, '反复观察也不得把父结果粘到回执上')
  } finally {
    await gateway.close()
  }
})

test('C 客户端：MCP dsh_task_status(wait=true) 与 CLI --status-wait 对回执只等自身终态（不再 waiting/exit3）', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway } = env
  const sessionId = 'sess-fix'
  try {
    const parentTaskId = await startParent(env, { sessionId, turn: 1 })
    const receipt = await steer(env, { instruction: 'S', sessionId, parentTaskId })
    assert.equal(receipt.status, 202)
    // 后台在此刻已经观察到（自身 rpc 在父回合里），但父任务仍在跑 → 客户端不得等父 done
    env.push(['user/message', { id: 'u-cli', role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: receipt.body.taskId } }])
    await until(async () => (await statusOf(gateway, receipt.body.taskId)).receiptState === 'observed')
    const mcp = await runMcp(env.mcpEnv, [
      mcpInit(0),
      mcpCall(1, 'dsh_task_status', { taskId: receipt.body.taskId, originThreadId: 'owner', wait: true, timeoutSec: 30 }),
    ], 40000)
    const payload = payloadOf(mcp.get(1))
    assert.equal(payload.phase, 'receipt-observed', 'MCP 必须返回回执终态而不是 waiting: ' + JSON.stringify(payload))
    assert.equal(payload.resultScope, 'parent-task')
    assert.notEqual(payload.status, 'waiting', 'MCP 不得返回 waiting')
    const cli = await runCli(['--status', receipt.body.taskId, '--origin', 'owner', '--status-wait', '--timeout', '30'], env.cliEnv)
    assert.notEqual(cli.status, 3, 'CLI 不得返回 exit3(waiting): ' + cli.stderr + ' | stdout=' + cli.stdout)
    assert.match(cli.stdout, /receipt-observed/, 'CLI 必须报告回执终态: ' + cli.stdout.slice(0, 400))
    assert.match(cli.stdout, /parent-task/, 'CLI 必须声明 resultScope=parent-task')
    assert.equal(/"status":\s*"waiting"/.test(cli.stdout), false, 'CLI 绝不返回 waiting: ' + cli.stdout.slice(0, 300))
    assert.equal(cli.status, 0, 'CLI 回执终态应退出 0: ' + cli.stderr)
  } finally {
    await gateway.close()
  }
})

// ================================================================ D 回放（Root 两个反例 + 旧缺前快照保留）

test('D 回放：缺前快照喂两遍得 OWN、含别回合的缺前快照得 OWN（且旧缺前快照回填仍工作）', () => {
  const assistant = (seq, turn, text) => ev(seq, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text }] } })
  const full = [ev(1, 'turn/start', { turn: 8 }), ev(2, 'user/message', { source: { rpcId: 'mine' } }), assistant(3, 8, 'OWN'), ev(4, 'turn/end', { turn: 8, reason: { kind: 'completed' } })]
  const duplicate = createRequestTracker('mine')
  for (let j = 0; j < 2; j++) for (const x of full.slice(1)) consumeSessionEvent(duplicate, x)
  for (const x of full) consumeSessionEvent(duplicate, x)
  assert.equal(duplicate.text, 'OWN', '重复缺前快照必须去重: ' + JSON.stringify(duplicate.text))
  assert.equal(duplicate.turn, 8)

  const foreign = createRequestTracker('mine')
  const throughNextTurn = [...full.slice(1), ev(5, 'turn/start', { turn: 9 }), ev(6, 'user/message', { source: { rpcId: 'someone-else' } }), assistant(7, 9, 'FOREIGN'), ev(8, 'turn/end', { turn: 9, reason: { kind: 'completed' } })]
  for (const x of throughNextTurn) consumeSessionEvent(foreign, x)
  for (const x of full) consumeSessionEvent(foreign, x)
  assert.equal(foreign.text, 'OWN', '不得把别回合文本记到自己头上: ' + JSON.stringify(foreign.text))

  // 旧行为保留：缺前半段（没有 turn/start）的合法回填仍要工作（不能一刀切把未知 turn 全标记 used）
  const backfill = createRequestTracker('mine')
  for (const x of full.slice(1)) consumeSessionEvent(backfill, x)   // 先只看到后半段
  for (const x of full) consumeSessionEvent(backfill, x)            // 再回填完整日志
  assert.equal(backfill.text, 'OWN', '缺前快照回填必须仍然有效: ' + JSON.stringify(backfill.text))
})

// ================================================================ E 审批 owner 严格当前开放回合

test('E owner 只认当前开放 queue 回合：旧 A(已 end) 的 callId 不得开出 A 的 pending；B 的 ask 归 B；回执永不 owner', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway } = env
  const sessionId = 'sess-owner'
  try {
    // A 派活并执行 turn1，然后 turn1 end + turn2 start（B 回合）
    const a = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'A', sessionId, originThreadId: 'owner', delegate: true, delegateTtlSec: 600 }, HEADERS)
    assert.equal(a.status, 202, JSON.stringify(a.body))
    env.push(['turn/start', { turn: 1 }], ['user/message', { id: 'u-a', role: 'user', content: [{ type: 'text', text: 'A' }], source: { rpcId: a.body.taskId } }])
    gateway.emitCtx('api-session/status', sessionId, true)
    await until(async () => {
      await gateway.runIntervals()
      return (await statusOf(gateway, a.body.taskId)).status === 'running'
    })
    // B 排进队列（同一会话，来源绑定）
    const b = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'B', sessionId, originThreadId: 'owner', delegate: true, delegateTtlSec: 600 }, HEADERS)
    assert.equal(b.status, 202, JSON.stringify(b.body))
    env.push(['turn/end', { turn: 1, reason: { kind: 'completed' } }], ['turn/start', { turn: 2 }], ['user/message', { id: 'u-b', role: 'user', content: [{ type: 'text', text: 'B' }], source: { rpcId: b.body.taskId } }])
    await until(async () => {
      await gateway.runIntervals()
      return (await statusOf(gateway, b.body.taskId)).status === 'running'
    })

    // 旧 A 的历史 tool/call（turn1）在现代（turn2）发来审批 → 绝不能开出 A 的 pending
    const callIdA = 'call-old-a'
    env.push(['tool/call', { turn: 1, step: 1, callId: callIdA, name: 'pwsh', arguments: '{}' }], ['approval/asked', { id: 'ask-old-a', toolName: 'pwsh', callId: callIdA }])
    gateway.emitCtx('tools/pre-execute', {
      agent: { session: { id: sessionId, header: { id: sessionId, cwd: 'E:/work' } } },
      callId: callIdA, rootCallId: callIdA, name: 'pwsh', arguments: { command: 'stale-a' },
    }, () => ({ kind: 'allow' }))
    const human = { count: 0 }
    const heldOld = gateway.emitCtx('approval/request', { agent: { session: { id: sessionId } }, toolName: 'pwsh', callId: callIdA, reason: 'stale' }, () => { human.count += 1; return Promise.resolve('rejected') })
    await sleep(300)
    const aList = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=owner&taskId=' + encodeURIComponent(a.body.taskId), HEADERS)
    assert.equal(aList.body.approvals.length, 0, '已结束的 A 不得接管当前回合的审批: ' + JSON.stringify(aList.body))
    assert.equal(human.count, 1, '旧 A 的 ask 必须交还人工链')
    assert.equal(await heldOld[0], 'rejected')

    // B 在当前开放回合里发来的 ask → owner 必须是 B
    const callIdB = 'call-new-b'
    env.push(['tool/call', { turn: 2, step: 1, callId: callIdB, name: 'pwsh', arguments: '{}' }], ['approval/asked', { id: 'ask-new-b', toolName: 'pwsh', callId: callIdB }])
    gateway.emitCtx('tools/pre-execute', {
      agent: { session: { id: sessionId, header: { id: sessionId, cwd: 'E:/work' } } },
      callId: callIdB, rootCallId: callIdB, name: 'pwsh', arguments: { command: 'new-b' },
    }, () => ({ kind: 'allow' }))
    const heldB = gateway.emitCtx('approval/request', { agent: { session: { id: sessionId } }, toolName: 'pwsh', callId: callIdB, reason: 'current' }, () => Promise.resolve('rejected'))
    const bListed = await until(async () => {
      const res = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=owner&taskId=' + encodeURIComponent(b.body.taskId), HEADERS)
      return res.body.ok === true && res.body.approvals.length > 0 ? res.body : false
    })
    assert.notEqual(bListed, false, '当前开放回合的 B 必须能挂起审批')
    assert.equal(bListed.approvals[0].grantId, b.body.grantId, 'owner 必须是 B 自己的 grant: ' + JSON.stringify(bListed.approvals[0]))
    const bPendingKey = bListed.approvals[0].approvalKey

    // 回执不参与 owner：对同一 open turn 派一条回执（同一个 B 回合）
    const receipt = await steer(env, { instruction: 'S', sessionId, parentTaskId: b.body.taskId, expectedTurn: 2 })
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body))
    const receiptList = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=owner&taskId=' + encodeURIComponent(receipt.body.taskId), HEADERS)
    assert.equal(receiptList.body.approvals.length, 0, '回执绝不能是审批 owner')

    // A 的"迟到 decided" 不得影响 B 的新 pending
    const aLate = await postJson(gateway.url + '/api/dsh-bridge/approvals/' + encodeURIComponent('does-not-exist') + '/decide', { originThreadId: 'owner', taskId: a.body.taskId, grantId: a.body.grantId, fingerprint: 'x', decision: 'approve' }, HEADERS)
    assert.equal(aLate.status >= 400, true, 'A 的迟到决定必须被拒: ' + JSON.stringify(aLate.body))
    const stillThere = await getJson(gateway.url + '/api/dsh-bridge/approvals?originThreadId=owner&taskId=' + encodeURIComponent(b.body.taskId), HEADERS)
    assert.equal(stillThere.body.approvals.some((p) => p.approvalKey === bPendingKey && p.state === 'pending'), true, 'B 的新 pending 必须不受 A 影响')
    await Promise.allSettled([...heldB, ...heldOld])
  } finally {
    await gateway.close()
  }
})

// ================================================================ 第二次验收 1：原生入口鉴权

test('第二次验收1：原生 steer 缺 key/坏 key 零派活（与 HTTP 同码），有效 key 才插入；普通 queue 不需 key', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway } = env
  const sessionId = 'sess-key'
  const originalKeyPath = process.env.DSH_APPROVAL_CONTROL_KEY_PATH
  try {
    const parentTaskId = await startParent(env, { sessionId, turn: 1 })
    // 指向一个明确不存在的 key 文件：HTTP 与原生必须**同样**拒绝，且都零 prompt
    const missingPath = path.join(keyDir, 'does-not-exist-' + Date.now() + '.key')
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = missingPath
    const before = gateway.prompts.length
    const httpSteer = await steer(env, { instruction: 'http', sessionId, parentTaskId })
    assert.equal(httpSteer.status, 401, 'HTTP steer 缺 key 必须 401: ' + JSON.stringify(httpSteer.body))
    assert.equal(httpSteer.body.reason, 'approval-key-missing')
    const nativeMissing = await gateway.callTool('dsh_collab_send', { instruction: 'native', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId, wait: false })
    assert.equal(nativeMissing.ok, false, '原生 steer 缺 key 必须拒绝: ' + JSON.stringify(nativeMissing))
    assert.equal(nativeMissing.reason, 'approval-key-missing', '原生要与 HTTP 同码: ' + JSON.stringify(nativeMissing))
    assert.equal(nativeMissing.resend, false)
    assert.equal(gateway.prompts.length, before, '缺 key 的原生 steer 必须零 prompt')

    // 坏 key（文件在但格式非法）
    const badPath = path.join(keyDir, 'bad-' + Date.now() + '.key')
    fs.writeFileSync(badPath, 'not-a-valid-control-key\n', 'utf8')
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = badPath
    const nativeBad = await gateway.callTool('dsh_collab_send', { instruction: 'native-bad', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId, wait: false })
    assert.equal(nativeBad.ok, false, '原生 steer 坏 key 必须拒绝: ' + JSON.stringify(nativeBad))
    assert.equal(nativeBad.reason, 'approval-control-invalid')
    assert.equal(gateway.prompts.length, before, '坏 key 的原生 steer 必须零 prompt')

    // 有效 key → 正常作为回执插入
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = originalKeyPath
    const nativeOk = await gateway.callTool('dsh_collab_send', { instruction: 'native-ok', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId, wait: false })
    assert.equal(nativeOk.taskId !== undefined, true, '有效 key 的原生 steer 必须被接收: ' + JSON.stringify(nativeOk))
    assert.equal(nativeOk.deliver, 'steer')
    assert.equal(gateway.prompts.length, before + 1, '有效 key 才真正插入一次')
    // 普通非委托 queue 不因缺 key 被拒（不加凭据前提）
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = missingPath
    const queueNoKey = await gateway.callTool('dsh_collab_send', { instruction: 'q', sessionId: 'sess-key-q', originThreadId: 'owner', deliver: 'queue', wait: false })
    assert.equal(queueNoKey.taskId !== undefined, true, '普通 queue 不应被强加 key 前提: ' + JSON.stringify(queueNoKey))
    // 父校验仍然生效（有效 key 但父不存在 → 零投递）
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = originalKeyPath
    const nativeBadParent = await gateway.callTool('dsh_collab_send', { instruction: 'x', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId: 'task-nope', wait: false })
    assert.equal(nativeBadParent.ok, false)
    assert.equal(nativeBadParent.reason, 'steer-parent-invalid')
  } finally {
    process.env.DSH_APPROVAL_CONTROL_KEY_PATH = originalKeyPath
    await gateway.close()
  }
})

// ================================================================ 第二次验收 2/3：回执终态单调 + 卸载零读写

test('第二次验收2：已证 observed 单调不回退（临时读失败/陈旧读取绝不改回 pending/unconfirmed）', async () => {
  const assocRoot = await makeTmp('dlv-life-assoc-')
  const storeRoot = await makeTmp('dlv-life-store-')
  const state = { events: [], unavailable: false, reads: 0 }
  const gateway = await startGateway({
    assocRoot,
    get events() {
      state.reads += 1
      if (state.unavailable) throw new Error('fixture transient session query failure')
      return state.events
    },
    env: { DSH_APPROVAL_DIR: storeRoot, DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '400', DSH_BRIDGE_RECEIPT_TOTAL_OBSERVE_MS: '180', DSH_BRIDGE_RECEIPT_POLL_MS: '50' },
  })
  const sessionId = 'sess-mono'
  try {
    const parent = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'parent', sessionId, originThreadId: 'owner' })
    assert.equal(parent.status, 202, JSON.stringify(parent.body))
    state.events.push(ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', { source: { rpcId: parent.body.taskId } }))
    gateway.emitCtx('api-session/status', sessionId, true)
    await until(async () => { await gateway.runIntervals(); return (await statusOf(gateway, parent.body.taskId)).status === 'running' })
    const receipt = await steer({ gateway, push: (...items) => { for (const i of items) state.events.push(ev(state.events.length + 1, i[0], i[1])) } }, { instruction: 'r', sessionId, parentTaskId: parent.body.taskId })
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body))
    // 自身 rpc 落进父回合 → 显式查询证明 observed
    state.events.push(ev(3, 'user/message', { source: { rpcId: receipt.body.taskId } }))
    const observed = await statusOf(gateway, receipt.body.taskId)
    assert.equal(observed.receiptState, 'observed', '查询必须证明 observed: ' + JSON.stringify(observed))
    const observedTurn = observed.observedTurn
    // 临时读失败：旧观察循环绝不能把已证事实改回 pending/unconfirmed
    state.unavailable = true
    await sleep(800)
    state.unavailable = false
    const afterRecovery = await statusOf(gateway, receipt.body.taskId)
    assert.equal(afterRecovery.receiptState, 'observed', '临时读失败/恢复后必须仍是 observed: ' + JSON.stringify(afterRecovery))
    assert.equal(afterRecovery.status, 'receipt-observed')
    assert.equal(afterRecovery.observedTurn, observedTurn)
    assert.equal(afterRecovery.result, undefined, '回执绝不承载父结果')
    assert.equal(gateway.prompts.filter((p) => p.requestId === receipt.body.taskId).length, 1, '全程只投递一次')
  } finally {
    await gateway.close()
  }
})

test('第二次验收2b：读取从未成功时**不下任何结论**（不 unconfirmed），恢复读取后由查询证明 observed', async () => {
  const assocRoot = await makeTmp('dlv-life2b-assoc-')
  const storeRoot = await makeTmp('dlv-life2b-store-')
  const state = { events: [], unavailable: false }
  const gateway = await startGateway({
    assocRoot,
    get events() { if (state.unavailable) throw new Error('fixture transient session query failure'); return state.events },
    env: { DSH_APPROVAL_DIR: storeRoot, DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '400', DSH_BRIDGE_RECEIPT_TOTAL_OBSERVE_MS: '180', DSH_BRIDGE_RECEIPT_POLL_MS: '50' },
  })
  const sessionId = 'sess-unread'
  try {
    const parent = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'parent', sessionId, originThreadId: 'owner' })
    state.events.push(ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', { source: { rpcId: parent.body.taskId } }))
    gateway.emitCtx('api-session/status', sessionId, true)
    await until(async () => { await gateway.runIntervals(); return (await statusOf(gateway, parent.body.taskId)).status === 'running' })
    const receipt = await steer({ gateway, push: () => {} }, { instruction: 'r', sessionId, parentTaskId: parent.body.taskId })
    assert.equal(receipt.status, 202)
    // 从观察起点起日志不可读，覆盖初始窗口 + 总寿命
    state.unavailable = true
    await sleep(900)
    const during = await statusOf(gateway, receipt.body.taskId)
    assert.notEqual(during.receiptState, 'unconfirmed', '读取失败绝不能写成 unconfirmed: ' + JSON.stringify(during))
    assert.notEqual(during.receiptState, 'observed', '读取失败也不能写 observed')
    assert.equal(['accepted', 'pending'].includes(during.receiptState), true, '只能是"还没结论": ' + JSON.stringify(during))
    // 恢复读取 + 自身 rpc 落进父回合 → 查询证明 observed
    state.unavailable = false
    state.events.push(ev(3, 'user/message', { source: { rpcId: receipt.body.taskId } }))
    const recovered = await until(async () => {
      const st = await statusOf(gateway, receipt.body.taskId)
      return st.receiptState === 'observed' ? st : false
    }, { timeoutMs: 4000 })
    assert.notEqual(recovered, false, '读取恢复后必须能证明 observed')
    assert.equal(recovered.status, 'receipt-observed')
    assert.equal(recovered.observedTurn, 1)
    assert.equal(recovered.result, undefined)
  } finally {
    await gateway.close()
  }
})

test('第二次验收3：卸载后回执观察零读取零写盘（初始循环与后台续证都要停）', async () => {
  const scaffold = async (name) => {
    const assocRoot = await makeTmp('dlv-unload-assoc-')
    const storeRoot = await makeTmp('dlv-unload-store-')
    const state = { events: [], reads: 0, closed: false }
    const gateway = await startGateway({
      assocRoot,
      get events() { state.reads += 1; return state.events },
      env: { DSH_APPROVAL_DIR: storeRoot, DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '400', DSH_BRIDGE_RECEIPT_TOTAL_OBSERVE_MS: '180', DSH_BRIDGE_RECEIPT_POLL_MS: '50' },
    })
    const sessionId = 'sess-' + name
    const parent = await postJson(gateway.url + '/api/dsh-bridge/task', { instruction: 'parent', sessionId, originThreadId: 'owner' })
    assert.equal(parent.status, 202, JSON.stringify(parent.body))
    state.events.push(ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', { source: { rpcId: parent.body.taskId } }))
    gateway.emitCtx('api-session/status', sessionId, true)
    await until(async () => { await gateway.runIntervals(); return (await statusOf(gateway, parent.body.taskId)).status === 'running' })
    const receipt = await steer({ gateway, push: () => {} }, { instruction: 'r', sessionId, parentTaskId: parent.body.taskId })
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body))
    const store = openAssociations({ root: assocRoot, namespace: process.env.DSH_BRIDGE_ASSOC_NAMESPACE || 'default' })
    return { gateway, state, store, receipt, sessionId }
  }

  // 初始有界等待循环中卸载
  const initial = await scaffold('unload-initial')
  try {
    const beforeClose = initial.store.fetch({ originThreadId: 'owner', taskId: initial.receipt.body.taskId }).record
    assert.equal(beforeClose.receiptState, 'accepted')
    await initial.gateway.close()
    initial.state.closed = true
    const readsAtClose = initial.state.reads
    const textAtClose = fs.readFileSync(initial.store.file, 'utf8')
    initial.state.events.push(ev(3, 'user/message', { source: { rpcId: initial.receipt.body.taskId } }))
    await sleep(700)
    assert.equal(initial.state.reads, readsAtClose, '卸载后不得再读会话（初始循环也要停）: reads=' + (initial.state.reads - readsAtClose))
    assert.equal(fs.readFileSync(initial.store.file, 'utf8'), textAtClose, '卸载后不得再写盘')
    const afterClose = initial.store.fetch({ originThreadId: 'owner', taskId: initial.receipt.body.taskId }).record
    assert.equal(afterClose.receiptState, 'accepted', '卸载后不得把 accepted 追写成 observed: ' + JSON.stringify(afterClose))
  } finally {
    try { await initial.gateway.close() } catch (e) { /* 已关闭 */ }
  }

  // 已进入后台续证后卸载（对照：本已正确，必须保持）
  const background = await scaffold('unload-background')
  try {
    await until(() => background.store.fetch({ originThreadId: 'owner', taskId: background.receipt.body.taskId }).record.receiptState === 'pending')
    await background.gateway.close()
    background.state.closed = true
    const readsWhenClosed = background.state.reads
    const persistedWhenClosed = fs.readFileSync(background.store.file, 'utf8')
    await sleep(400)
    assert.equal(background.state.reads, readsWhenClosed, '后台循环卸载后必须零读取')
    assert.equal(fs.readFileSync(background.store.file, 'utf8'), persistedWhenClosed, '后台循环卸载后必须零写盘')
  } finally {
    try { await background.gateway.close() } catch (e) { /* 已关闭 */ }
  }
})


test('F 原生 dsh_collab_send：能新建 steer（真实 execute 接线），缺父零投递；queue 等待认得 queued', async () => {
  const env = await setup({ DSH_BRIDGE_RECEIPT_OBSERVE_TIMEOUT_MS: '1500' })
  const { gateway } = env
  const sessionId = 'sess-native'
  try {
    // 原生工具确实注册了（否则 callTool 会抛错）
    assert.equal(gateway.tools.some((t) => t.name === 'dsh_collab_send'), true, '原生 dsh_collab_send 必须注册')
    const schema = gateway.tools.find((t) => t.name === 'dsh_collab_send').parameters
    assert.equal(typeof schema.parentTaskId, 'object', '原生 schema 必须带 parentTaskId: ' + JSON.stringify(Object.keys(schema)))
    assert.equal(typeof schema.expectedTurn, 'object', '原生 schema 必须带 expectedTurn')

    const parentTaskId = await startParent(env, { sessionId, turn: 1 })
    // 缺父 → 零投递（原生入口不放宽校验）
    const before = gateway.prompts.length
    const noParent = await gateway.callTool('dsh_collab_send', { instruction: 'x', sessionId, originThreadId: 'owner', deliver: 'steer', wait: false })
    assert.equal(noParent.ok, false)
    assert.equal(noParent.reason, 'steer-parent-required')
    assert.equal(gateway.prompts.length, before, '缺父必须零投递')

    // 有效父 → 作为回执投递（原生入口）
    const nativeSteer = await gateway.callTool('dsh_collab_send', { instruction: 'S-native', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId, expectedTurn: 1, wait: false })
    assert.equal(nativeSteer.taskId !== undefined, true, '原生 steer 必须被接收: ' + JSON.stringify(nativeSteer))
    assert.equal(nativeSteer.deliver, 'steer')
    assert.equal(nativeSteer.parentTaskId, parentTaskId)
    assert.equal(nativeSteer.resultScope, 'parent-task')
    assert.equal(gateway.prompts.filter((p) => p.mode === 'steer').length, 1, '原生入口必须真的发出 steer')
    // wait=true 时只等回执自身终态（不是父任务的 done）：并发地在等待期间让自身 rpcId 落进父回合。
    const waitPromise = gateway.callTool('dsh_collab_send', { instruction: 'S-native-2', sessionId, originThreadId: 'owner', deliver: 'steer', parentTaskId, wait: true })
    await sleep(500)
    const liveList = await getJson(gateway.url + '/api/dsh-bridge/status?originThreadId=owner')
    const pendingReceipts = liveList.body.tasks.filter((t) => t.deliver === 'steer' && (t.status === 'receipt-pending' || t.status === 'accepted'))
    assert.equal(pendingReceipts.length > 0, true, '原生 wait 期间必须有在观察的回执: ' + JSON.stringify(liveList.body.tasks))
    // 让所有仍在观察的回执都拿到自身 rpcId（逐个 is 唯一匹配其 requestId）
    for (const [index, row] of pendingReceipts.entries()) {
      env.push(['user/message', { id: 'u-native-late-' + index, role: 'user', content: [{ type: 'text', text: 'S' }], source: { rpcId: row.taskId } }])
    }
    const waited = await waitPromise
    assert.equal(waited.phase, 'receipt-observed', '原生 wait 必须返回回执终态: ' + JSON.stringify(waited))
    assert.equal(waited.resultScope, 'parent-task')
    assert.notEqual(waited.status, 'done', '原生 wait 绝不把回执当父任务结果')
    assert.equal(waited.resend, false)

    // queue：忙时接收，wait 认得 queued（不会立刻当成完成）
    const queued = await gateway.callTool('dsh_collab_send', { instruction: 'Q-native', sessionId, originThreadId: 'owner', deliver: 'queue', wait: false })
    assert.equal(queued.status, 'queued', '忙时 queue 必须是 queued: ' + JSON.stringify(queued))
  } finally {
    await gateway.close()
  }
})
