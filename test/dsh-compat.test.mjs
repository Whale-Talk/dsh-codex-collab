/**
 * 宿主契约守卫（只读 app.asar）：DSH 升级时**第一时间**暴露漂移。
 *
 * 背景：本插件依赖宿主的一批真实入口（tools 定义、approval/request 瀑布、agent 生命周期 hook、
 * 子代理入口、模型目录、会话投影）。DSH 在小版本间搬过这些入口（例如 0.2.2-rc.1 把审批状态
 * 改为 `ctx.sessionProjections` 投影、把回合边界从 `dsh-agent-loop` 移到 `dsh-agent` 的
 * `turnBoundaryOf`）。本测试只读当前安装的 asar，做两件事：
 *   1. 插件声明的 `engines.dsh` 必须**覆盖**当前安装的 DSH 版本（不满足 → 明确失败）；
 *   2. 插件依赖的入口字符串必须仍然存在（缺失 → 明确失败并列出）。
 *
 * 证据边界（诚实声明）：这是**本机安装**的只读契约检查，不是行为测试；没有 DSH 安装时整体 skip。
 * 跑法: node test/dsh-compat.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const ASAR = process.env.DSH_ASAR || 'D:/Program Files (x86)/DSH/resources/app.asar'
let hasAsar = false
try { fs.accessSync(ASAR); hasAsar = true } catch (e) { hasAsar = false }
const SKIP = hasAsar ? false : 'app.asar 不在本机（DSH_ASAR=' + ASAR + '）——没有 DSH 安装就诚实跳过'

/** 极简 semver：支持 >= > <= < = 与 x.y.z[-pre][+build]（够用于 engines.dsh 的常见写法）。 */
const parseSemver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim())
  if (match === null) throw new Error('not a semver: ' + JSON.stringify(value))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] === undefined ? [] : match[4].split('.') }
}
const compareIdentifiers = (left, right) => {
  const numeric = (id) => /^\d+$/.test(id)
  if (numeric(left) && numeric(right)) return Number(left) - Number(right)
  if (numeric(left)) return -1
  if (numeric(right)) return 1
  return left < right ? -1 : (left > right ? 1 : 0)
}
const compareSemver = (left, right) => {
  for (const key of ['major', 'minor', 'patch']) {
    const diff = left[key] - right[key]
    if (diff !== 0) return diff
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1                 // release > prerelease
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    if (left.pre[index] === undefined) return -1
    if (right.pre[index] === undefined) return 1
    const diff = compareIdentifiers(left.pre[index], right.pre[index])
    if (diff !== 0) return diff
  }
  return 0
}
const satisfiesComparator = (version, comparator) => {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator)
  if (match === null) return false
  const operator = match[1] === undefined ? '=' : match[1]
  const target = parseSemver(match[2])
  const diff = compareSemver(version, target)
  if (operator === '>=') return diff >= 0
  if (operator === '<=') return diff <= 0
  if (operator === '>') return diff > 0
  if (operator === '<') return diff < 0
  return diff === 0
}
const satisfiesRange = (versionText, range) => {
  const version = parseSemver(versionText)
  const comparators = String(range).trim().split(/\s+/).filter((part) => part !== '' && part !== '*')
  if (comparators.length === 0) return true
  for (const comparator of comparators) {
    if (!/^(>=|<=|>|<|=)?\s*\d/.test(comparator) && !/^[0-9]/.test(comparator)) throw new Error('unsupported engines.dsh range form: ' + JSON.stringify(range))
    if (!satisfiesComparator(version, comparator)) return false
  }
  return true
}

/** 只读 asar：读一个文本文件（不存在返回 undefined）。 */
const readAsarText = (pointer) => {
  if (!hasAsar) return undefined
  const fd = fs.openSync(ASAR, 'r')
  try {
    const pre = Buffer.alloc(16)
    fs.readSync(fd, pre, 0, 16, 0)
    const header = Buffer.alloc(pre.readUInt32LE(12))
    fs.readSync(fd, header, 0, header.length, 16)
    const tree = JSON.parse(header.toString('utf8'))
    const dataOffset = 8 + pre.readUInt32LE(4)
    let node = tree
    for (const part of pointer.split('/')) { node = node?.files?.[part]; if (node === undefined) return undefined }
    if (node.size === undefined) return undefined
    const buffer = Buffer.alloc(Number(node.size))
    fs.readSync(fd, buffer, 0, buffer.length, dataOffset + Number(node.offset))
    return buffer.toString('utf8')
  } finally { fs.closeSync(fd) }
}

const pluginPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const runtimeVersion = (() => {
  const text = readAsarText('dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json')
  return text === undefined ? undefined : JSON.parse(text).version
})()

test('宿主版本：声明 engines.dsh 且覆盖当前安装的 DSH', { skip: SKIP }, () => {
  assert.equal(typeof pluginPkg.engines?.dsh, 'string', 'package.json 必须声明 engines.dsh（DSH 用它评估插件兼容性）')
  assert.equal(satisfiesRange(runtimeVersion, pluginPkg.engines.dsh), true, 'engines.dsh=' + JSON.stringify(pluginPkg.engines.dsh) + ' 不覆盖当前 DSH ' + runtimeVersion + '：需要核对新宿主并更新兼容范围')
  // 0.2.2-rc.1 是当前验证基线；未来宿主升级到别的大版本时必须显式复核
  assert.match(runtimeVersion, /^0\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, '当前宿主版本形状异常: ' + runtimeVersion)
})

test('宿主入口：本插件依赖的 SDK 入口仍存在（DSH 升级漂移守卫）', { skip: SKIP }, () => {
  /** 每个条目：asar 内文件 + 必须包含的字符串（这些是插件接线依赖的真实入口，不是镜像）。 */
  const contracts = [
    ['dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js', ['defineTool'], '原生工具定义入口'],
    ['dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js', ['approvalStateDefinition', 'approval/request', 'sessionProjections'], '审批瀑布 + 投影状态'],
    ['dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js', ['sessionProjections', 'stateOf'], '会话投影注册服务'],
    ['dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js', ['turnBoundaryProjectionDefinition', 'turnBoundaryOf', 'isOwnedBy'], '回合/步进边界投影 + 精确归属'],
    ['dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', ['agent/inbox/claimed', 'agent/request-error', 'prepareRequest'], 'AgentLoop 生命周期 hook'],
    ['dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js', ['startActivation', 'async prompt('], '子代理创建/继续入口'],
    ['dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', ['listProviders', 'listModels', 'resolveModelInfo'], '模型目录 API'],
    ['dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js', ['saveSelection', 'hasPromptRequest'], 'prompt 去重 + 全局默认（知道它存在但绝不使用）'],
    ['dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js', ['snapshotEvents'], '会话事件读取面'],
  ]
  const missing = []
  for (const [pointer, needles, label] of contracts) {
    const text = readAsarText(pointer)
    if (text === undefined) { missing.push(label + '：文件不存在（' + pointer + '）'); continue }
    for (const needle of needles) if (!text.includes(needle)) missing.push(label + '：缺少 ' + JSON.stringify(needle) + '（' + pointer + '）')
  }
  assert.deepEqual(missing, [], '宿主入口漂移，需要按新 DSH 更新插件与证据：\n' + missing.join('\n'))
})

test('反向通道：bundle patch 不再内置已移除的 `codex mcp-server`（Codex 0.167）', () => {
  const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8')
  // 只检查**生效的 YAML 行**：注释里说明历史原因是允许的。
  assert.equal(/args:\s*\[[^\]]*mcp-server/.test(patch), false, 'bundle patch 不得再启动 Codex 0.167 已移除的 `codex mcp-server`')
  assert.equal(/^\s*-\s*id:\s*codex-mcp\s*$/m.test(patch), false, 'bundle patch 不应再内置 codex-mcp 行')
  assert.match(patch, /dsh-bridge/, 'dsh-bridge 行必须保留')

  const templatePath = path.join(repoRoot, 'templates', 'codex-mcp', 'cordis.patch.yml')
  const template = fs.readFileSync(templatePath, 'utf8')
  assert.match(template, /mcp-server/, '仅旧版 Codex 可用的反向通道配置必须保留在模板里')
  assert.match(template, /legacy|旧版|0\.\d+xx/i, '模板必须标注这是旧版 Codex 的可选配置')

  const templateReadme = fs.readFileSync(path.join(repoRoot, 'templates', 'codex-mcp', 'README.md'), 'utf8')
  assert.match(templateReadme, /mcp-server/, '模板 README 必须写明 codex mcp-server 前提')
  assert.match(templateReadme, /0\.167|已移除|removed/i, '模板 README 必须说明 Codex 0.167 已移除 mcp-server')
})

