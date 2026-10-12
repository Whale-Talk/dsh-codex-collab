/**
 * codex-desktop-probe.mjs 的判定测试（P2-4）。
 *
 * 判定必须是纯函数、可离线验证：**不启动任何服务、不连任何端点**。
 * 覆盖：桌面身份必须由祖先链证明（命令行里有 app-server 不算）、独立 CLI 单列、
 * 扫描失败 → probe-inconclusive、存在端点信号 → endpoint-present-unverified、
 * canWakeIdle/canObserveTurns 恒 false、以及临时 schema 目录删除前的路径校验。
 *
 * 跑法: node test/codex-desktop-probe.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  PROBE_REASONS,
  classifyProcesses,
  decideCapabilities,
  isDesktopAppProcess,
  isInsideDirectory,
  isInstalledAppPath,
  parseScanOutput,
} from '../mcp/codex-desktop-probe.mjs'

const PROBE = path.resolve(import.meta.dirname, '..', 'mcp', 'codex-desktop-probe.mjs')

const proc = (over) => ({
  ProcessId: 1,
  ParentProcessId: 0,
  Name: 'codex.exe',
  ExecutablePath: 'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe',
  CommandLine: '"C:\\...\\codex.exe" app-server --analytics-default-enabled',
  ...over,
})

const DESKTOP_APP = {
  ProcessId: 44100,
  ParentProcessId: 1,
  Name: 'ChatGPT.exe',
  ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
  CommandLine: '"ChatGPT.exe"',
}

test('isInstalledAppPath / isDesktopAppProcess：只认安装式桌面 App', () => {
  assert.equal(isInstalledAppPath('C:\\Program Files\\WindowsApps\\OpenAI.Codex_x\\app\\ChatGPT.exe'), true)
  assert.equal(isInstalledAppPath('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd'), false)
  assert.equal(isInstalledAppPath('C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\h\\codex.exe'), false)
  assert.equal(isDesktopAppProcess(DESKTOP_APP), true)
  // 名字对但在 npm 目录里 → 不是桌面 App
  assert.equal(isDesktopAppProcess({ Name: 'ChatGPT.exe', ExecutablePath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\ChatGPT.exe' }), false)
  // 安装路径但名字不是桌面 App → 不算
  assert.equal(isDesktopAppProcess({ Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\x\\node.exe' }), false)
})

test('classifyProcesses：桌面身份必须由祖先链证明，手工起的 app-server 单列', () => {
  const processes = [
    DESKTOP_APP,
    proc({ ProcessId: 17068, ParentProcessId: 44100 }),                                    // 桌面的 app-server
    { ProcessId: 999, ParentProcessId: 1, Name: 'pwsh.exe', ExecutablePath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', CommandLine: 'pwsh' },
    proc({ ProcessId: 555, ParentProcessId: 999, CommandLine: '"C:\\...\\codex.exe" app-server --listen ws://127.0.0.1:9999' }),  // 手工起的
    proc({ ProcessId: 777, ParentProcessId: 424242 }),                                     // 祖先拿不到
    { ProcessId: 888, ParentProcessId: 44100, Name: 'codex.exe', ExecutablePath: 'C:\\...\\codex.exe', CommandLine: '"codex.exe" mcp-server' },
  ]
  const result = classifyProcesses({ processes, scanOk: true })
  assert.equal(result.ok, true)
  assert.equal(result.appServerCount, 3)
  assert.deepEqual(result.desktop.map((d) => d.pid), [17068])
  assert.match(result.desktop[0].why, /ancestor ChatGPT\.exe/)
  assert.deepEqual(result.standalone.map((d) => d.pid), [555])
  assert.equal(result.standalone[0].listenUrl, 'ws://127.0.0.1:9999')
  assert.deepEqual(result.unidentified.map((d) => d.pid), [777])
  // `mcp-server` 不是 app-server，不进任何一列
  assert.equal([...result.desktop, ...result.standalone, ...result.unidentified].some((d) => d.pid === 888), false)
})

test('classifyProcesses：祖先链先穿过另一份 app-server 的实例必须单列（不能算桌面端点）', () => {
  const CODEX_RUNTIME = 'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\h\\bin\\'
  const processes = [
    DESKTOP_APP,
    proc({ ProcessId: 17068, ParentProcessId: 44100 }),                                     // 桌面的主 app-server
    { ProcessId: 53104, ParentProcessId: 17068, Name: 'node.exe', ExecutablePath: CODEX_RUNTIME + 'node.exe', CommandLine: 'node' },
    { ProcessId: 50084, ParentProcessId: 53104, Name: 'node_repl.exe', ExecutablePath: CODEX_RUNTIME + 'node_repl.exe', CommandLine: 'node_repl.exe' },
    proc({ ProcessId: 19848, ParentProcessId: 50084, CommandLine: '"C:\\...\\codex.exe" app-server --listen stdio://' }),
  ]
  const result = classifyProcesses({ processes, scanOk: true })
  // 只有直接挂在桌面 App 下的那一个才算"桌面正在使用的后台"
  assert.deepEqual(result.desktop.map((d) => d.pid), [17068])
  assert.match(result.desktop[0].why, /ancestor ChatGPT\.exe/)
  // 经 node_repl 派生、祖先链先遇到另一份 app-server 的实例 → 单列，不当作桌面端点
  assert.deepEqual(result.standalone.map((d) => d.pid), [19848])
  assert.match(result.standalone[0].why, /passes through another app-server \(pid 17068\)/)
  assert.equal(result.standalone[0].ancestry.length, 4)
  assert.deepEqual(result.unidentified, [])
})

test('classifyProcesses：扫描失败不猜结论', () => {
  const result = classifyProcesses({ processes: [], scanOk: false, scanError: 'powershell unavailable' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'powershell unavailable')
  assert.deepEqual(result.desktop, [])
  assert.equal(result.appServerCount, 0)
})

test('decideCapabilities：扫描失败 → probe-inconclusive（不宣称没有端点）', () => {
  const base = { listenerScan: { ok: true, listeners: [] }, controlSocket: { exists: false }, daemon: { attempted: true, ok: false } }

  const processFailed = decideCapabilities({ ...base, processScan: { ok: false, error: 'cim down' } })
  assert.equal(processFailed.reason, PROBE_REASONS.INCONCLUSIVE)
  assert.equal(processFailed.canWakeIdle, false)
  assert.match(processFailed.detail, /cim down/)

  const listenerFailed = decideCapabilities({ ...base, listenerScan: { ok: false, error: 'netstat down' }, processScan: { ok: true, desktop: [], standalone: [], unidentified: [], appServerCount: 0 } })
  assert.equal(listenerFailed.reason, PROBE_REASONS.INCONCLUSIVE)
  assert.match(listenerFailed.detail, /netstat down/)
})

test('decideCapabilities：存在端点信号 → endpoint-present-unverified，仍不得宣称可唤醒', () => {
  const stdioDesktop = [{ pid: 1, listenUrl: 'stdio:// (default)', tcpListeners: [] }]
  const scanOk = (desktop) => ({ ok: true, desktop, standalone: [], unidentified: [], appServerCount: desktop.length })
  const base = { listenerScan: { ok: true, listeners: [] }, daemon: { attempted: true, ok: false } }

  // 桌面用了非 stdio 的 --listen（即使没有任何 TCP 监听，比如 unix socket）
  const wsListen = decideCapabilities({ ...base, processScan: scanOk([{ pid: 2, listenUrl: 'ws://127.0.0.1:9999', tcpListeners: [] }]), controlSocket: { exists: false } })
  assert.equal(wsListen.reason, PROBE_REASONS.ENDPOINT_UNVERIFIED)
  assert.equal(wsListen.canWakeIdle, false)
  assert.equal(wsListen.canObserveTurns, false)

  // 控制套接字存在
  const socket = decideCapabilities({ ...base, processScan: scanOk(stdioDesktop), controlSocket: { exists: true, path: 'C:\\...\\app-server-control.sock' } })
  assert.equal(socket.reason, PROBE_REASONS.ENDPOINT_UNVERIFIED)

  // daemon 探测成功
  const daemon = decideCapabilities({ ...base, processScan: scanOk(stdioDesktop), controlSocket: { exists: false }, daemon: { attempted: true, ok: true } })
  assert.equal(daemon.reason, PROBE_REASONS.ENDPOINT_UNVERIFIED)
})

test('decideCapabilities：stdio-only 且无任何端点信号 → desktop-attachment-unavailable', () => {
  const result = decideCapabilities({
    processScan: { ok: true, desktop: [{ pid: 17068, listenUrl: 'stdio:// (default)', tcpListeners: [] }], standalone: [], unidentified: [], appServerCount: 1 },
    listenerScan: { ok: true, listeners: [] },
    controlSocket: { exists: false },
    daemon: { attempted: true, ok: false, error: 'failed to connect ... os error 10050' },
  })
  assert.equal(result.reason, PROBE_REASONS.UNAVAILABLE)
  assert.equal(result.available, false)
  assert.equal(result.deliveryMode, 'inbox')
  assert.equal(result.canWakeIdle, false)
  assert.equal(result.canObserveTurns, false)

  // 连桌面 app-server 都没观察到：同样是 unavailable，但 detail 要能区分
  const none = decideCapabilities({
    processScan: { ok: true, desktop: [], standalone: [], unidentified: [], appServerCount: 0 },
    listenerScan: { ok: true, listeners: [] },
    controlSocket: { exists: false },
    daemon: { attempted: false, ok: false },
  })
  assert.equal(none.reason, PROBE_REASONS.UNAVAILABLE)
  assert.match(none.detail, /no verified desktop app-server observed/)
})

test('isInsideDirectory：删除前的路径校验必须挡住越界与同名前缀', () => {
  const tempRoot = path.resolve(os.tmpdir())
  assert.equal(isInsideDirectory(path.join(tempRoot, 'codex-schema-probe-abc'), tempRoot), true)
  assert.equal(isInsideDirectory(tempRoot, tempRoot), false)                       // 同一个目录不算"之内"
  assert.equal(isInsideDirectory(path.join(tempRoot, '..', 'evil'), tempRoot), false)
  assert.equal(isInsideDirectory('C:\\Windows', tempRoot), false)
  // 同名前缀不能被当成子目录
  assert.equal(isInsideDirectory(tempRoot + '-evil', tempRoot), false)
})

test('parseScanOutput：采集层必须把"没有结果"和"结果为空"分开（非终止错误不得被当成功）', () => {
  const MARK = 'DSH_PROBE_JSON:'

  // 非零退出 + **有效 payload**：依然必须失败（退出码优先于 payload）
  const nonZeroWithPayload = parseScanOutput({ status: 1, stdout: MARK + '[]', stderr: 'fixture-query-error', kind: 'listener' })
  assert.equal(nonZeroWithPayload.ok, false)
  assert.match(nonZeroWithPayload.error, /exited non-zero or unconfirmed \(exit 1\)/)
  assert.match(nonZeroWithPayload.error, /fixture-query-error/)

  // 退出码无法确认（缺失/非整数）同样不当作成功
  for (const bad of [undefined, null, '0', 1.5]) {
    const result = parseScanOutput({ status: bad, stdout: MARK + '[]', kind: 'process' })
    assert.equal(result.ok, false, 'status=' + String(bad) + ' 不得当成功')
    assert.match(result.error, /exited non-zero or unconfirmed/)
  }

  // PowerShell 非终止查询错误：exit 0 + stdout 空 + stderr 有内容 → 必须 ok:false
  const silentFailure = parseScanOutput({ status: 0, stdout: '', stderr: '', kind: 'listener' })
  assert.equal(silentFailure.ok, false)
  assert.match(silentFailure.error, /produced no payload \(exit 0\)/)

  const withStderr = parseScanOutput({ status: 0, stdout: '\n', stderr: 'Get-NetTCPConnection : Access denied', kind: 'listener' })
  assert.equal(withStderr.ok, false)
  assert.match(withStderr.error, /Access denied/)

  // 非零退出且没有 payload → 仍报"退出码非零"
  const crashed = parseScanOutput({ status: 1, stdout: '', stderr: 'boom', kind: 'process' })
  assert.equal(crashed.ok, false)
  assert.match(crashed.error, /exit 1/)

  // 有标记但 JSON 坏了 / 是 null → ok:false
  assert.equal(parseScanOutput({ status: 0, stdout: MARK + '{oops', kind: 'process' }).ok, false)
  assert.equal(parseScanOutput({ status: 0, stdout: MARK + 'null', kind: 'process' }).ok, false)

  // 真正的空结果：exit 0 + 标记 + [] → ok:true 且 items 为空
  const emptyOk = parseScanOutput({ status: 0, stdout: MARK + '[]', kind: 'listener' })
  assert.equal(emptyOk.ok, true)
  assert.deepEqual(emptyOk.items, [])

  // 单条结果（ConvertTo-Json 输出对象而不是数组）→ 归一成数组
  const single = parseScanOutput({ status: 0, stdout: MARK + '{"ProcessId":1}', kind: 'process' })
  assert.equal(single.ok, true)
  assert.deepEqual(single.items, [{ ProcessId: 1 }])
})

test('采集层失败会一路传导为 probe-inconclusive（不是只向判定函数手填 ok:false）', () => {
  const MARK = 'DSH_PROBE_JSON:'
  // 用真实的解析结果（模拟"非终止错误 + exit 0 + 空 stdout"）构造证据
  const processScan = parseScanOutput({ status: 0, stdout: '', stderr: 'CIM unavailable', kind: 'process' })
  const listenerScan = parseScanOutput({ status: 0, stdout: MARK + '[]', kind: 'listener' })
  const decision = decideCapabilities({
    processScan: { ok: processScan.ok, error: processScan.error, desktop: [], standalone: [], unidentified: [], appServerCount: 0 },
    listenerScan: { ok: listenerScan.ok, error: listenerScan.error, listeners: listenerScan.items },
    controlSocket: { exists: false },
    daemon: { attempted: true, ok: false },
  })
  assert.equal(decision.reason, PROBE_REASONS.INCONCLUSIVE)
  assert.match(decision.detail, /CIM unavailable/)
})

test('doctor 端到端：只读运行、字段齐全、能力如实、schema 临时目录不残留', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = path.resolve(os.tmpdir())
  const before = fs.readdirSync(tempRoot).filter((n) => n.startsWith('codex-schema-probe-')).length

  const run = spawnSync(process.execPath, [PROBE, '--schema'], { encoding: 'utf8', timeout: 180000, windowsHide: true })
  assert.equal(run.status, 0, 'probe 应以 0 退出：' + (run.stderr || '').slice(0, 300))
  const report = JSON.parse(run.stdout)
  assert.equal(report.probe, 'codex-desktop-attachment')
  assert.equal(typeof report.processScan.ok, 'boolean')
  assert.equal(typeof report.listenerScan.ok, 'boolean')
  assert.equal(typeof report.controlSocket.exists, 'boolean')
  assert.ok(Array.isArray(report.desktop) && Array.isArray(report.standalone) && Array.isArray(report.unidentified))
  assert.equal(report.capabilities.deliveryMode, 'inbox')
  assert.equal(report.capabilities.canWakeIdle, false)
  assert.equal(report.capabilities.canObserveTurns, false)
  // 两条扫描都必须成功，才允许给出"可用/不可用"结论；任一失败都必须是 probe-inconclusive
  if (report.processScan.ok === true && report.listenerScan.ok === true) {
    assert.equal([PROBE_REASONS.UNAVAILABLE, PROBE_REASONS.ENDPOINT_UNVERIFIED].includes(report.capabilities.reason), true)
  } else {
    assert.equal(report.capabilities.reason, PROBE_REASONS.INCONCLUSIVE)
  }

  const after = fs.readdirSync(tempRoot).filter((n) => n.startsWith('codex-schema-probe-')).length
  assert.equal(after, before, 'schema 临时目录必须被清理干净')
})
