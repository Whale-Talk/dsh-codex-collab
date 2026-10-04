/**
 * dsh-bridge.mjs 的路由级回归测试：用假 DSH 运行时触发真实 apply(ctx)。
 * 跑法: node --test test/*.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let fixtureRoot
let bridgePromise

const repoRoot = path.resolve(import.meta.dirname, '..')
const tmpParent = path.resolve(os.tmpdir())

const loadBridge = async () => {
  if (bridgePromise !== undefined) return bridgePromise
  bridgePromise = (async () => {
    fixtureRoot = await mkdtemp(path.join(tmpParent, 'dsh-bridge-test-'))
    await cp(path.join(repoRoot, 'harness'), path.join(fixtureRoot, 'harness'), { recursive: true })
    const stubRoot = path.join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    await mkdir(stubRoot, { recursive: true })
    await writeFile(path.join(stubRoot, 'package.json'), JSON.stringify({ type: 'module', main: './index.js', exports: './index.js' }), 'utf8')
    await writeFile(path.join(stubRoot, 'index.js'), 'export const defineTool = (tool) => tool\n', 'utf8')
    return import(pathToFileURL(path.join(fixtureRoot, 'harness', 'dsh-bridge.mjs')).href)
  })()
  return bridgePromise
}

after(async () => {
  if (fixtureRoot === undefined) return
  const resolved = path.resolve(fixtureRoot)
  if (!resolved.startsWith(tmpParent + path.sep) || !path.basename(resolved).startsWith('dsh-bridge-test-')) {
    throw new Error('refusing to remove unexpected fixture path: ' + resolved)
  }
  await rm(resolved, { recursive: true, force: true })
})

const makeReq = (body) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/dsh-bridge/task'
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

const callJson = async (handler, body) => {
  let done
  const ended = new Promise((resolve) => { done = resolve })
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    end(chunk = '') {
      this.body += chunk
      done({
        statusCode: this.statusCode,
        headers: this.headers,
        body: this.body === '' ? undefined : JSON.parse(this.body),
      })
    },
  }
  await handler(makeReq(body), res)
  return ended
}

const makeHarness = async () => {
  const { apply } = await loadBridge()
  const routes = new Map()
  const cleanups = []
  const starts = []
  const owners = []
  const prompts = []
  const tools = []
  const controller = {
    async resolveAgent(sessionId) {
      return { sessionId }
    },
    async prompt(args) {
      prompts.push(args)
      return {}
    },
    async *follow() {},
  }
  const ctx = {
    webServer: {
      exact: new Map(),
      upgrades: new Map(),
      register(route) {
        routes.set(route.path, route.handler)
        this.exact.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route) {
        this.upgrades.set(route.path, route.handler)
        return () => this.upgrades.delete(route.path)
      },
    },
    agents: {
      list() {
        return [{ options: { provider: 'fake-provider', model: 'fake-model' } }]
      },
      async create(options) {
        owners.push(options)
        return {
          agent: { id: 'owner-1', ctx: { on() {} } },
          dispose() {},
        }
      },
    },
    subagents: {
      list() {
        return ['subagent']
      },
      getProvider() {
        return { prepareContinuable() {} }
      },
      async startContinuable(args) {
        starts.push(args)
        return { childId: 'child-1' }
      },
      async followup() {
        throw new Error('followup should not run in first-dispatch worker test')
      },
      interrupt() {},
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    },
    on() {
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  await apply(ctx)
  return { routes, starts, owners, prompts, tools, cleanups }
}

test('POST /task: default worker dispatch starts a continuable subagent', async () => {
  const harness = await makeHarness()
  const task = harness.routes.get('/api/dsh-bridge/task')

  const res = await callJson(task, {
    instruction: '跑一个 worker 回归测试',
    cwd: 'E:/tmp/dsh-worker',
    lane: 'main',
  })

  assert.equal(res.statusCode, 202)
  assert.equal(res.body.status, 'accepted')
  assert.deepEqual(res.body.target, { kind: 'worker', cwd: 'E:\\tmp\\dsh-worker', lane: 'main' })
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.starts[0].provider, 'subagent')
  assert.equal(harness.starts[0].label, 'codex-collab-worker-main')
  assert.match(harness.starts[0].request.prompt[0].text, /跑一个 worker 回归测试/)
})

test('POST /task: session dispatch preserves queue and steer delivery modes', async () => {
  for (const mode of ['queue', 'steer']) {
    const harness = await makeHarness()
    const task = harness.routes.get('/api/dsh-bridge/task')

    const res = await callJson(task, {
      instruction: '投递到已有会话',
      target: { kind: 'session', sessionId: 'session-' + mode },
      deliver: mode,
    })

    assert.equal(res.statusCode, 202)
    assert.equal(res.body.target.kind, 'session')
    assert.equal(res.body.target.deliver, mode)
    assert.equal(harness.prompts.length, 1)
    assert.equal(harness.prompts[0].mode, mode)
    assert.equal(harness.prompts[0].sessionId, 'session-' + mode)
    assert.deepEqual(harness.prompts[0].content, [{ type: 'text', text: '投递到已有会话' }])
    assert.equal(harness.starts.length, 0)
    assert.equal(harness.owners.length, 0)
  }
})
