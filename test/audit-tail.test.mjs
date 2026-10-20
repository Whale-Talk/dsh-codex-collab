import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuditTailReader } from '../harness/audit-tail.mjs'

test('audit tail is bounded, cached, tolerates broken rows and notices replacement', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-tail-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'audit.jsonl')
  fs.writeFileSync(file, ('{"taskId":"old","kind":"old"}\n').repeat(200) + '{broken}\n' + '{"taskId":"t","kind":"first"}\n')
  const reader = createAuditTailReader({ file: () => file, fallback: () => [], maxBytes: 1024 })
  assert.deepEqual(reader.read('t').map(x => x.kind), ['first'])
  for (let i = 0; i < 20; i++) reader.read('t')
  assert.equal(reader.status().reads, 1)
  assert.equal(reader.status().bytes, 1024)
  assert.equal(reader.status().truncated, true)
  fs.appendFileSync(file, '{"taskId":"t","kind":"second"}\n')
  assert.deepEqual(reader.read('t').map(x => x.kind), ['first', 'second'])
  fs.writeFileSync(file, '{"taskId":"t","kind":"replacement"}\n')
  assert.deepEqual(reader.read('t').map(x => x.kind), ['replacement'])
  fs.unlinkSync(file)
  assert.deepEqual(reader.read('t'), [])
})
