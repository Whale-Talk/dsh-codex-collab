#!/usr/bin/env node
/**
 * codex-desktop-probe.mjs —— 只读的桌面接入能力探针（doctor）。
 *
 * 回答一个问题：**本机现在能不能连上 Codex Desktop 正在使用的那个后台**，从而把消息投进
 * 它已经打开的那条聊天？本探针只观察、不写入、不启动任何服务、不读凭据、不碰会话存储。
 *
 * 判定纪律（P2-4 之后）：
 *   - "是桌面后台"必须由**父进程/祖先/二进制归属**证明，而不是"命令行里有 app-server"。
 *     手工起在终端里的 app-server 会单列为 standalone 候选，绝不当成桌面。
 *   - **同一份存储不能证明是同一后台**：本探针不拿 storage 做判定，只在报告里附注。
 *   - 进程扫描或 TCP 扫描**失败** → probe-inconclusive（而不是宣称没有端点）。
 *   - 控制套接字存在、或 daemon 探测成功、或桌面 app-server 用了非 stdio 的 --listen
 *     → endpoint-present-unverified（**不因为"没有 TCP 监听"就声称没有端点**）。
 *   - canWakeIdle / canObserveTurns 一律为 false，直到真的完成协议校验与同聊天 canary。
 *
 * 输出：JSON（stdout）+ 人话摘要（stderr）。`--schema` 会把协议 JSON Schema 生成到临时目录
 * 检查关键方法后删除（删除前显式校验目标位于系统临时根之内）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 三种结论。 */
export const PROBE_REASONS = {
  UNAVAILABLE: 'desktop-attachment-unavailable',
  ENDPOINT_UNVERIFIED: 'endpoint-present-unverified',
  INCONCLUSIVE: 'probe-inconclusive',
}

const DESKTOP_APP_RE = /^(chatgpt|codex)\.exe$/i

/** 安装式应用路径（Store 包 / Programs）——用来认同"这是桌面 App 本体"。 */
export const isInstalledAppPath = (exe) => {
  if (typeof exe !== 'string' || exe === '') return false
  const lower = exe.toLowerCase()
  return lower.includes('\\program files\\windowsapps\\') || lower.includes('\\appdata\\local\\programs\\') || /\\programs\\[^\\]+\\/.test(lower)
}

/**
 * 候选桌面 App 进程：名字是 ChatGPT/Codex 且位于安装式路径。
 * 注意：桌面用的 bundled CLI 也在 %LOCALAPPDATA%\OpenAI\Codex\bin 下，所以**二进制路径本身
 * 不足以判定**桌面——必须靠祖先链（见 classifyProcesses）。
 */
export const isDesktopAppProcess = (proc) => {
  if (proc === null || typeof proc !== 'object') return false
  const name = typeof proc.Name === 'string' ? proc.Name : ''
  return DESKTOP_APP_RE.test(name) && isInstalledAppPath(proc.ExecutablePath)
}

const looksLikeAppServer = (proc) => typeof proc.CommandLine === 'string'
  && /\bapp-server\b/.test(proc.CommandLine)
  && !/mcp-server/.test(proc.CommandLine)

const listenUrlOf = (commandLine) => {
  if (typeof commandLine !== 'string') return null
  const m = /--listen\s+(\S+)/.exec(commandLine)
  return m === null ? null : m[1]
}

const ancestryOf = (proc, byPid, maxDepth = 6) => {
  const chain = []
  let current = proc
  for (let depth = 0; depth < maxDepth; depth++) {
    const parentId = current === null || typeof current !== 'object' ? undefined : current.ParentProcessId
    const parent = byPid.get(parentId)
    if (parent === undefined) break
    chain.push({ pid: parent.ProcessId, Name: parent.Name, ExecutablePath: parent.ExecutablePath, CommandLine: parent.CommandLine, name: parent.Name, executable: parent.ExecutablePath })
    current = parent
  }
  return chain
}

/**
 * 纯分类：把"命令行里带 app-server 的进程"分成桌面 / 独立 CLI / 无法确认。
 *
 *   - desktop：祖先链里**先**遇到安装式桌面 App（ChatGPT.exe/Codex.exe 在安装路径下）；
 *   - standalone：祖先链里**先**遇到另一份 app-server（说明本实例是由那份后台派生的），
 *     或能确认祖先链里既没有桌面 App 也没有别的 app-server（手工起的 CLI）；
 *   - unidentified：祖先链不完整（拿不到父进程快照）→ 既不认作桌面，也不当作独立 CLI。
 *
 * 关键点：**祖先同属桌面并不足以证明某个 app-server 就是桌面正在使用的那个后台**。
 * 桌面自己的运行时（node_repl/node）会派生出额外的 app-server 实例，它们的祖先链会先穿过
 * 桌面那个主 app-server —— 这类实例必须单列，不能算作桌面端点。
 */
export const classifyProcesses = ({ processes, scanOk, scanError }) => {
  if (scanOk !== true) {
    return { ok: false, error: scanError === undefined ? 'process scan failed' : scanError, desktop: [], standalone: [], unidentified: [], appServerCount: 0 }
  }
  const list = Array.isArray(processes) ? processes : []
  const byPid = new Map(list.map((p) => [p.ProcessId, p]))
  const desktop = []
  const standalone = []
  const unidentified = []
  for (const proc of list) {
    if (!looksLikeAppServer(proc)) continue
    const ancestry = ancestryOf(proc, byPid)
    const entry = {
      pid: proc.ProcessId,
      executable: proc.ExecutablePath,
      listenUrl: listenUrlOf(proc.CommandLine) === null ? 'stdio:// (default)' : listenUrlOf(proc.CommandLine),
      tcpListeners: [],
      ancestry,
    }
    // 从近到远扫描祖先：谁先出现就按谁分类（另一份 app-server 会遮断归属）。
    let classified = null
    for (const ancestor of ancestry) {
      if (looksLikeAppServer(ancestor)) {
        classified = { kind: 'standalone', why: 'ancestry passes through another app-server (pid ' + ancestor.pid + '); not proven to be the desktop backend' }
        break
      }
      if (isDesktopAppProcess({ Name: ancestor.name, ExecutablePath: ancestor.executable })) {
        classified = { kind: 'desktop', why: 'ancestor ' + ancestor.name + ' (pid ' + ancestor.pid + ') at ' + ancestor.executable }
        break
      }
    }
    if (classified !== null && classified.kind === 'desktop') {
      desktop.push({ ...entry, verifiedAsDesktop: true, why: classified.why })
    } else if (classified !== null) {
      standalone.push({ ...entry, verifiedAsDesktop: false, why: classified.why })
    } else if (ancestry.length > 0) {
      standalone.push({ ...entry, verifiedAsDesktop: false, why: 'ancestry has no installed desktop app and no other app-server: ' + ancestry.map((a) => a.name).join(' < ') })
    } else {
      unidentified.push({ ...entry, verifiedAsDesktop: false, why: 'ancestry unresolved (parent process not in snapshot)' })
    }
  }
  const appServerCount = desktop.length + standalone.length + unidentified.length
  return { ok: true, desktop, standalone, unidentified, appServerCount }
}

/**
 * 纯判定：证据 → 能力结论。**任何扫描失败都先判 inconclusive**，绝不猜"没有端点"。
 * canWakeIdle/canObserveTurns 恒为 false：它们要等协议校验 + 同一聊天 canary 真的通过。
 */
export const decideCapabilities = (evidence) => {
  const processScan = evidence.processScan === undefined ? { ok: false, error: 'missing' } : evidence.processScan
  const listenerScan = evidence.listenerScan === undefined ? { ok: false, error: 'missing' } : evidence.listenerScan
  const controlSocket = evidence.controlSocket === undefined ? { exists: false } : evidence.controlSocket
  const daemon = evidence.daemon === undefined ? { attempted: false, ok: false } : evidence.daemon

  const failedScans = []
  if (processScan.ok !== true) failedScans.push('process scan: ' + (processScan.error === undefined ? 'failed' : processScan.error))
  if (listenerScan.ok !== true) failedScans.push('listener scan: ' + (listenerScan.error === undefined ? 'failed' : listenerScan.error))
  if (failedScans.length > 0) {
    return {
      available: false,
      deliveryMode: 'inbox',
      canWakeIdle: false,
      canObserveTurns: false,
      reason: PROBE_REASONS.INCONCLUSIVE,
      detail: 'cannot conclude anything about desktop attachment: ' + failedScans.join('; '),
      signals: { attachableDesktopServers: 0, controlSocket: controlSocket.exists === true, daemonOk: daemon.ok === true },
    }
  }

  const desktop = Array.isArray(processScan.desktop) ? processScan.desktop : []
  const attachable = desktop.filter((d) => typeof d.listenUrl === 'string' && !d.listenUrl.startsWith('stdio://'))
  const endpointSignals = []
  if (attachable.length > 0) endpointSignals.push(attachable.length + ' verified desktop app-server(s) on a non-stdio --listen URL: ' + attachable.map((d) => d.listenUrl).join(', '))
  if (controlSocket.exists === true) endpointSignals.push('app-server control socket exists at ' + controlSocket.path)
  if (daemon.ok === true) endpointSignals.push('app-server daemon probe succeeded')

  if (endpointSignals.length > 0) {
    return {
      available: false,
      deliveryMode: 'inbox',
      canWakeIdle: false,
      canObserveTurns: false,
      reason: PROBE_REASONS.ENDPOINT_UNVERIFIED,
      detail: 'a possible endpoint exists but has NOT been verified: ' + endpointSignals.join('; ') + '. Still required: connect to the same backend, thread/loaded/list must contain the target, observe live turns, then a same-chat canary.',
      signals: { attachableDesktopServers: attachable.length, controlSocket: controlSocket.exists === true, daemonOk: daemon.ok === true },
    }
  }

  const detail = desktop.length === 0
    ? 'no verified desktop app-server observed (npx/standalone app-servers do not count; same storage dir is not proof of the same backend); no control socket; daemon probe failed or unsupported'
    : 'verified desktop app-server runs stdio:// owned by its desktop parent; no non-stdio --listen URL; no control socket; daemon probe failed or unsupported'

  return {
    available: false,
    deliveryMode: 'inbox',
    canWakeIdle: false,
    canObserveTurns: false,
    reason: PROBE_REASONS.UNAVAILABLE,
    detail,
    signals: { attachableDesktopServers: 0, controlSocket: controlSocket.exists === true, daemonOk: daemon.ok === true },
  }
}

/** 删除前必须证明目标确实位于预期父目录内。 */
export const isInsideDirectory = (candidate, parent) => {
  const child = path.resolve(candidate)
  const base = path.resolve(parent)
  const relative = path.relative(base, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const safe = (fn, fallback) => {
  try { return fn() } catch (e) { return fallback }
}

/** 采集脚本用它自己的退出码和这一行标记来区分"空结果"与"没结果"。 */
const SCAN_MARKER = 'DSH_PROBE_JSON:'

/**
 * 采集层解析（纯函数，可测）。
 *
 * 为什么必须这么严：PowerShell 的**非终止**查询错误会让进程以 0 退出、stdout 为空。
 * 如果把它当成"扫描成功且结果为空"，探针就会从"没查到"误推成"没有端点"（unavailable）。
 * 所以约定：脚本必须打印 `DSH_PROBE_JSON:<json>`；没有这一行、或退出码非 0、或 JSON 解不出，
 * 一律返回 ok:false，由判定层给出 probe-inconclusive。
 */
export const parseScanOutput = ({ status, stdout, stderr, kind }) => {
  const detail = stderr === undefined || String(stderr).trim() === '' ? '' : (': ' + String(stderr).trim().slice(0, 200))
  // 退出码优先：非零（或根本不是整数、无法确认）时先失败——即使 stdout 里带了一个合法 payload，
  // 也不能当作"采集成功"。否则 `exit 1 + DSH_PROBE_JSON:[]` 会被读成"扫描成功且结果为空"，
  // 进而把"没查到"误推成"没有端点"。
  if (typeof status !== 'number' || !Number.isInteger(status) || status !== 0) {
    return { ok: false, error: kind + ' scan exited non-zero or unconfirmed (exit ' + status + ')' + detail }
  }
  const text = typeof stdout === 'string' ? stdout : ''
  const line = text.split('\n').find((l) => l.startsWith(SCAN_MARKER))
  if (line === undefined) {
    return { ok: false, error: kind + ' scan produced no payload (exit ' + status + ')' + detail }
  }
  let parsed
  try {
    parsed = JSON.parse(line.slice(SCAN_MARKER.length))
  } catch (e) {
    return { ok: false, error: kind + ' scan payload is not valid JSON' + detail }
  }
  if (parsed === null || parsed === undefined) return { ok: false, error: kind + ' scan payload was null' + detail }
  return { ok: true, items: Array.isArray(parsed) ? parsed : [parsed] }
}

const runPowershell = (script) => {
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const stdout = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      return { status: 0, stdout, stderr: '' }
    } catch (e) {
      if (e.code === 'ENOENT') continue
      // 非零退出：保留 stdout/stderr 供解析层判断
      return {
        status: typeof e.status === 'number' ? e.status : 1,
        stdout: e.stdout === undefined ? '' : e.stdout,
        stderr: e.stderr === undefined ? e.message : e.stderr,
      }
    }
  }
  return { status: -1, stdout: '', stderr: 'no powershell available' }
}

const DEBUG_SILENT = '$ProgressPreference = "SilentlyContinue"; '

const readProcesses = () => {
  // -ErrorAction Stop：让查询错误变成**终止**错误（非零退出），不再被静默吞掉。
  const script = DEBUG_SILENT
    + '$ErrorActionPreference = "Stop"; '
    + 'try { '
    + "  $items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'codex|ChatGPT' -or $_.Name -eq 'node_repl.exe' -or ($_.ExecutablePath -ne $null -and $_.ExecutablePath -like '*\\OpenAI\\Codex\\*') } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); "
    + "  $json = if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress -Depth 4 }; "
    + "  Write-Output ('" + SCAN_MARKER + "' + $json) "
    + '} catch { Write-Error $_; exit 1 }'
  const result = runPowershell(script)
  const parsed = parseScanOutput({ ...result, kind: 'process' })
  if (parsed.ok !== true) return { ok: false, error: parsed.error, processes: [] }
  return { ok: true, processes: parsed.items }
}

const readListeners = () => {
  const script = DEBUG_SILENT
    + '$ErrorActionPreference = "Stop"; '
    + 'try { '
    + '  $items = @(Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess); '
    + "  $json = if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress -Depth 3 }; "
    + "  Write-Output ('" + SCAN_MARKER + "' + $json) "
    + '} catch { Write-Error $_; exit 1 }'
  const result = runPowershell(script)
  const parsed = parseScanOutput({ ...result, kind: 'listener' })
  if (parsed.ok !== true) return { ok: false, error: parsed.error, listeners: [] }
  return { ok: true, listeners: parsed.items }
}

const readPipes = () => safe(() => fs.readdirSync('\\\\.\\pipe\\').filter((n) => /codex/i.test(n)).sort(), [])

const versionOf = (exe) => {
  if (typeof exe !== 'string' || exe === '' || !fs.existsSync(exe)) return null
  return safe(() => execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim(), null)
}

/** 取全局 CLI 版本：Windows 上 `codex` 是 `.cmd` 垫片，直接 spawn 会失败，退回 shim + shell。 */
const globalCliVersion = () => {
  const direct = safe(() => execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim(), null)
  if (direct !== null && direct !== '') return direct
  const shim = path.join(process.env.APPDATA === undefined ? '' : process.env.APPDATA, 'npm', 'codex.cmd')
  if (!fs.existsSync(shim)) return null
  const viaShell = safe(() => execFileSync(shim, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, shell: true }).trim(), null)
  return viaShell === null || viaShell === '' ? null : viaShell
}

const probeDaemon = (exe) => {
  if (typeof exe !== 'string' || exe === '' || !fs.existsSync(exe)) return { attempted: false, ok: false, reason: 'no bundled codex cli found' }
  try {
    const out = execFileSync(exe, ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    return { attempted: true, ok: true, output: out.trim().slice(0, 400) }
  } catch (e) {
    return { attempted: true, ok: false, error: ((e.stdout === undefined ? '' : e.stdout) + (e.stderr === undefined ? '' : e.stderr)).trim().slice(0, 400) }
  }
}

const checkSchema = (exe) => {
  if (typeof exe !== 'string' || exe === '' || !fs.existsSync(exe)) return { attempted: false, reason: 'no bundled codex cli found' }
  const tempRoot = path.resolve(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(tempRoot, 'codex-schema-probe-'))
  try {
    execFileSync(exe, ['app-server', 'generate-json-schema', '--out', dir], { encoding: 'utf8', timeout: 60000, windowsHide: true })
    const files = fs.readdirSync(dir, { recursive: true })
    const has = (needle) => files.some((f) => String(f).includes(needle))
    return {
      attempted: true,
      ok: true,
      keyMethods: {
        initialize: has('InitializeParams'),
        threadLoadedList: has('ThreadLoadedListParams'),
        threadRead: has('ThreadReadParams'),
        threadList: has('ThreadListParams'),
        turnStart: has('TurnStartParams'),
        turnSteer: has('TurnSteerParams'),
        turnInterrupt: has('TurnInterruptParams'),
        threadInjectItems: has('ThreadInjectItemsParams'),
      },
    }
  } catch (e) {
    return { attempted: true, ok: false, error: (e.message || '').slice(0, 300) }
  } finally {
    // 递归删除前显式校验：解析后的目标必须真的在系统临时根之内。
    if (isInsideDirectory(dir, tempRoot)) {
      safe(() => fs.rmSync(dir, { recursive: true, force: true }), null)
    } else {
      process.stderr.write('refusing to remove schema dir outside the temp root: ' + dir + '\n')
    }
  }
}

const main = () => {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
  const wantSchema = flags.has('--schema')

  const processRead = readProcesses()
  const listenerRead = readListeners()
  const classified = classifyProcesses({ processes: processRead.processes, scanOk: processRead.ok, scanError: processRead.error })

  // 把 TCP 监听挂到分类结果上（只按 pid 对应，不做其它推断）
  const listeners = listenerRead.listeners
  for (const group of [classified.desktop, classified.standalone, classified.unidentified]) {
    for (const entry of group) entry.tcpListeners = listeners.filter((l) => l.OwningProcess === entry.pid).map((l) => l.LocalAddress + ':' + l.LocalPort)
  }

  const controlSocket = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
  const bundledExe = classified.desktop.length > 0 ? classified.desktop[0].executable : (classified.standalone.length > 0 ? classified.standalone[0].executable : null)

  const evidence = {
    processScan: { ok: processRead.ok, error: processRead.error, ...classified },
    listenerScan: { ok: listenerRead.ok, error: listenerRead.error, listeners },
    controlSocket: { path: controlSocket, exists: fs.existsSync(controlSocket) },
    daemon: probeDaemon(bundledExe),
  }
  const capabilities = decideCapabilities(evidence)
  const schema = wantSchema ? checkSchema(bundledExe) : { attempted: false, reason: 'pass --schema to check protocol surface' }

  const report = {
    probe: 'codex-desktop-attachment',
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    globalCliVersion: globalCliVersion(),
    processScan: { ok: processRead.ok, error: processRead.error, appServerCount: classified.appServerCount },
    desktop: classified.desktop,
    standalone: classified.standalone,
    unidentified: classified.unidentified,
    listenerScan: { ok: listenerRead.ok, error: listenerRead.error, count: listeners.length },
    controlSocket: evidence.controlSocket,
    daemonProbe: evidence.daemon,
    namedPipes: { count: readPipes().length, sample: readPipes().slice(0, 8) },
    schema,
    capabilities,
    notes: [
      'read-only probe: no writes outside an optional temp schema dir (validated before deletion), no service started, no credentials read, no session storage touched',
      'desktop identity requires a verified desktop ancestor, not just an app-server command line; standalone app-servers are listed separately',
      'the same storage directory does NOT prove the same backend and is deliberately not used as evidence here',
      'ordinary MCP notifications and Work-Cloud-only MCP Events are NOT local desktop wake and are not counted here',
    ],
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.stderr.write('capabilities: deliveryMode=' + capabilities.deliveryMode + ' canWakeIdle=' + capabilities.canWakeIdle + ' reason=' + capabilities.reason + '\n')
  process.stderr.write('desktop app-servers: ' + (classified.desktop.length === 0 ? 'none verified' : classified.desktop.map((d) => 'pid=' + d.pid + ' listen=' + d.listenUrl).join('; ')) + '\n')
  process.stderr.write('standalone app-servers: ' + (classified.standalone.length === 0 ? 'none' : classified.standalone.map((d) => 'pid=' + d.pid).join(', ')) + '; control socket exists: ' + evidence.controlSocket.exists + '\n')
}

/** 只有作为程序直接运行时才真的探测；被 import（例如判定测试）时不得产生副作用。 */
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isDirectRun) main()
