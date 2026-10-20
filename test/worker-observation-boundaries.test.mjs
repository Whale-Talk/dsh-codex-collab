import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { flush } from './helpers/session-observer-fixtures.mjs'
import { startGateway, makeTmp, disposeAll } from './helpers/dsh-host.mjs'
import { rememberTask } from '../harness/task-table.mjs'
test.after(disposeAll)
const post = async (gateway, instruction) => {
  const response = await fetch(gateway.url + '/api/dsh-bridge/task', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction, cwd: 'E:/synthetic-worker-boundaries', originThreadId: 'worker-boundary-fixture' }),
  })
  return { status: response.status, body: await response.json() }
}
const status = (gateway, taskId) => fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + taskId + '&originThreadId=worker-boundary-fixture').then(r => r.json())
const setup = async (t) => {
  const assocRoot = await makeTmp('dsh-worker-boundaries-')
  const previousKey = process.env.DSH_APPROVAL_CONTROL_KEY_PATH
  process.env.DSH_APPROVAL_CONTROL_KEY_PATH = path.join(assocRoot, 'missing-synthetic-fixture.key')
  const originalNow = Date.now
  let currentTime = originalNow()
  Date.now = () => currentTime
  const events = []
  let failNext = false
  const query = {
    async readSession() {
      if (failNext) { failNext = false; throw new Error('synthetic history unavailable') }
      return { events: structuredClone(events), cursor: events.length ? events.at(-1).seq : -1 }
    },
  }
  const gateway = await startGateway({ assocRoot, sessionQuery: query, env: { DSH_APPROVAL_DIR: path.join(assocRoot, 'synthetic-approvals') } })
  t.after(async () => {
    await gateway.close()
    Date.now = originalNow
    if (previousKey === undefined) delete process.env.DSH_APPROVAL_CONTROL_KEY_PATH
    else process.env.DSH_APPROVAL_CONTROL_KEY_PATH = previousKey
  })
  return { gateway, events, failNextRead: () => { failNext = true }, advance: (ms) => { currentTime += ms } }
}

test('reused worker refuses delivery if fresh history boundary fails and later avoids old output', { timeout: 8000 }, async (t) => {
  const f = await setup(t)
  const first = await post(f.gateway, 'WORKER_BOUNDARY_FIRST')
  assert.equal(first.status, 202)
  assert.equal(await f.gateway.waitForChild('WORKER_BOUNDARY_FIRST'), true)
  await flush()
  f.events.push({ seq: 0, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'OLD-WORKER-OUTPUT' }] } } })
  await f.gateway.runIntervals(10)
  assert.equal(f.gateway.complete('WORKER_BOUNDARY_FIRST', 'OFFICIAL-FIRST-RESULT'), true)
  await flush()
  assert.equal((await status(f.gateway, first.body.taskId)).status, 'done')
  const prompts = f.gateway.followups.length
  f.failNextRead()
  const refused = await post(f.gateway, 'WORKER_BOUNDARY_REFUSE')
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /fresh history boundary.*nothing was sent/)
  assert.equal(f.gateway.followups.length, prompts, 'failed boundary must produce zero worker continuation prompts')
  const recovered = await post(f.gateway, 'WORKER_BOUNDARY_RECOVERED')
  assert.equal(recovered.status, 202)
  f.advance(5000)
  await f.gateway.runIntervals(10)
  const view = await status(f.gateway, recovered.body.taskId)
  assert.notEqual(view.status, 'done')
  assert.equal(view.result, undefined)
  assert.equal(view.partialResult, undefined, 'old worker history must not become the new task output')
})

test('quiet unknown worker retains ownership until its eventual official completion', { timeout: 8000 }, async (t) => {
  const f = await setup(t)
  const first = await post(f.gateway, 'WORKER_LATE_OFFICIAL_END')
  assert.equal(first.status, 202)
  assert.equal(await f.gateway.waitForChild('WORKER_LATE_OFFICIAL_END'), true)
  await flush()
  f.events.push({ seq: 0, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'PARTIAL-ONLY' }] } } })
  await f.gateway.runIntervals(10)
  f.advance(600001)
  await f.gateway.runIntervals(10)
  const quiet = await status(f.gateway, first.body.taskId)
  const competing = await post(f.gateway, 'WORKER_MUST_NOT_STEAL_OLD_END')
  assert.equal(f.gateway.complete('WORKER_LATE_OFFICIAL_END', 'OFFICIAL-LATE-RESULT'), true)
  await flush()
  const completed = await status(f.gateway, first.body.taskId)
  const competingView = competing.status === 202 ? await status(f.gateway, competing.body.taskId) : null
  t.diagnostic(JSON.stringify({ quiet: quiet.status, competing: competing.status, originalAfterEnd: completed.status, originalResult: completed.result, competingAfterEnd: competingView?.status, competingResult: competingView?.result }))
  assert.equal(quiet.status, 'unknown')
  assert.equal(competing.status, 400, 'an unconfirmed live child must not accept a competing same-lane owner')
  assert.equal(competing.body.reason, 'worker-bucket-busy')
  assert.equal(completed.status, 'done', 'the original task must retain its eventual official completion')
  assert.equal(completed.result, 'OFFICIAL-LATE-RESULT')
  assert.equal(completed.error, undefined)
  assert.equal(completed.reason, undefined)
})

test('only unconfirmed workers still awaiting official end are protected from eviction', () => {
  const tasks = [], held = { status: 'unknown', awaitingOfficialEnd: true }
  rememberTask(tasks, held, 2)
  for (let i = 0; i < 210; i++) rememberTask(tasks, { status: 'done', taskId: String(i) }, 2)
  assert.equal(tasks.includes(held), true)
  delete held.awaitingOfficialEnd
  rememberTask(tasks, { status: 'done', taskId: 'last' }, 2)
  assert.equal(tasks.includes(held), false)
})
