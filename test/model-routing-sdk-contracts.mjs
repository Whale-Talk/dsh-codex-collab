// M0 证据：只读 app.asar，核实 canonical 计划依赖的真实 API/hook 契约（本插件侧独立复核）
import fs from 'node:fs'

const ASAR = process.env.DSH_ASAR || 'D:/Program Files (x86)/DSH/resources/app.asar'
const fd = fs.openSync(ASAR, 'r')
const pre = Buffer.alloc(16)
fs.readSync(fd, pre, 0, 16, 0)
const header = Buffer.alloc(pre.readUInt32LE(12))
fs.readSync(fd, header, 0, header.length, 16)
const tree = JSON.parse(header.toString('utf8'))
const dataOffset = 8 + pre.readUInt32LE(4)
const readText = (pointer) => {
  let node = tree
  for (const part of pointer.split('/')) { if (part === '') continue; node = node?.files?.[part]; if (node === undefined) return undefined }
  if (node === undefined || node.size === undefined) return undefined
  const buf = Buffer.alloc(Number(node.size))
  fs.readSync(fd, buf, 0, Number(node.size), dataOffset + Number(node.offset))
  return buf.toString('utf8')
}
const grep = (pointer, pattern, label) => {
  const text = readText(pointer)
  if (text === undefined) { console.log('MISSING ' + pointer); return }
  const lines = text.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 150) })
  console.log('\n== ' + label + ' (' + pointer + ') hits=' + hits.length)
  for (const h of hits.slice(0, 6)) console.log('  :' + h.line + '  ' + h.text)
}

grep('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', /listProviders\(|listModels\(|resolveModelInfo\(|resolveCallConfig\(|adapters-updated/, 'Llm 目录/能力 API')
grep('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', /UNSUPPORTED_REASONING_EFFORT/, 'effort 显式不支持即拒绝（不 clamp）')
grep('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /agent\/request-error|waterfall\(.agent\/request'|prepareRequest/, 'AgentLoop 请求/错误 hook 与 prepareRequest')
grep('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /user\/message|firstAttempt/, '首次 request 早于 user/message 落盘')
grep('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /agent\/inbox\/claimed/, 'claimed 事件（首请求归属）')
grep('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /only after|complete assistant|tool call/i, '工具只在完整 assistant 消息后执行')
grep('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', /EMPTY_RESPONSE|RATE_LIMIT|maxRetries|retries/, '原生重试策略与可重试码')
grep('dsh/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js', /always|normal|request-error/, 'retry middleware（normal/always 语义）')
grep('dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js', /selectModel|saveSelection/, 'selectModel 会写全局 default（不得使用）')
grep('dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js', /childId|agentOptions/, 'subagent childId 预分配 / agentOptions 覆盖入口')
fs.closeSync(fd)
