import test,{after}from'node:test';import assert from'node:assert/strict';import{startGateway,makeTmp,disposeAll}from'./helpers/dsh-host.mjs';
after(disposeAll);
test('healthy follow does not re-read complete history during session sweeps',async()=>{
 let reads=0;const query={async readSession(){reads++;return{events:[]};}};
 const gateway=await startGateway({assocRoot:await makeTmp('dsh-observation-'),sessionQuery:query,follow:async function*(_request,signal){yield{type:'snapshot',cursor:-1,records:[],hasMore:false};await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});}});
 try{const r=await fetch(gateway.url+'/api/dsh-bridge/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instruction:'observe only this synthetic task',sessionId:'synthetic-large-session',originThreadId:'01a100f1-045c-7e10-84c7-ac8ec37eff3f'})});assert.equal(r.status,202);await new Promise(r=>setTimeout(r,30));const before=reads;for(let i=0;i<6;i++)await gateway.runIntervals(10);assert.equal(reads-before,0,'connected follow must not periodically clone the same history');}finally{await gateway.close();}
});

test('queued tasks share one native observation and settle only their own RPC', async () => {
  let fullReads = 0, observations = 0
  const events = [], session = { id: 'native-shared', seq: 0 }
  const query = {
    async readSession() { fullReads++; throw new Error('native path must not clone history') },
    async observeSession(_id, options) { observations++; assert.equal(options.projectionMode, 'none'); return { events: events.slice(), cursor: session.seq - 1, [Symbol.dispose]() {} } },
  }
  const gateway = await startGateway({ assocRoot: await makeTmp('dsh-native-perf-'), sessions: new Map([[session.id, session]]), sessionQuery: query })
  try {
    const accepted = []
    for (let i = 0; i < 6; i++) {
      const res = await fetch(gateway.url + '/api/dsh-bridge/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'queued-' + i, sessionId: session.id, originThreadId: 'perf-source' }) })
      assert.equal(res.status, 202); accepted.push(await res.json())
    }
    const before = observations
    for (let i = 0; i < 10; i++) await gateway.runIntervals(2)
    assert.equal(observations, before); assert.equal(fullReads, 0); assert.equal(before, 1)
    const append = (type, data) => { const event = { seq: session.seq++, type, data }; events.push(event); gateway.emitCtx('session/event', session, event) }
    append('turn/start', { turn: 1 })
    append('user/message', { source: { rpcId: accepted[0].taskId } })
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ONLY-A' }] } })
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const status = id => fetch(gateway.url + '/api/dsh-bridge/status?taskId=' + id + '&originThreadId=perf-source').then(r => r.json())
    assert.equal((await status(accepted[0].taskId)).result, 'ONLY-A')
    assert.equal((await status(accepted[1].taskId)).status, 'accepted')
    assert.equal(observations, before); assert.equal(fullReads, 0)
  } finally { await gateway.close() }
})

test('completed workers do not read history on idle sweeps', async () => {
  let reads = 0
  const gateway = await startGateway({ assocRoot: await makeTmp('dsh-idle-perf-'), sessionQuery: { async readSession() { reads++; return { events: [] } } } })
  try {
    const res = await fetch(gateway.url + '/api/dsh-bridge/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'IDLE_PERF_MARKER', cwd: 'E:/tmp/idle-perf', originThreadId: 'perf-source' }) })
    assert.equal(res.status, 202)
    assert.equal(await gateway.waitForChild('IDLE_PERF_MARKER'), true)
    assert.equal(gateway.complete('IDLE_PERF_MARKER', 'finished'), true)
    await new Promise(resolve => setImmediate(resolve))
    const before = reads
    for (let i = 0; i < 6; i++) await gateway.runIntervals(2)
    assert.equal(reads, before)
  } finally { await gateway.close() }
})

test('DSH 0.2.1 activation entry is selected without invoking the removed continuable entry', async () => {
  const calls = []
  const gateway = await startGateway({ assocRoot: await makeTmp('dsh-activation-perf-'), subagents: {
    async startActivation(spec) { calls.push(spec); return { childId: spec.childId || 'activation-child', result: Promise.resolve({ stopReason: 'completed', output: [] }) } },
    async startContinuable() { assert.fail('removed API must never be invoked when activation is supported') },
  } })
  try {
    const response = await fetch(gateway.url + '/api/dsh-bridge/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'SDK_ACTIVATION', cwd: 'E:/tmp/activation-perf', originThreadId: 'perf-source' }) })
    assert.equal(response.status, 202)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].delivery, 'caller')
    assert.equal(calls[0].provider, 'subagent')
    assert.equal(calls[0].request.parent.id, 'owner-1')
    assert.ok(calls[0].request.prompt[0].text.includes('SDK_ACTIVATION'))
  } finally { await gateway.close() }
})

