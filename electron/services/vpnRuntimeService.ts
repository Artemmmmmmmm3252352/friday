import { constants } from 'node:fs'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import AdmZip from 'adm-zip'

import type { VpnConfig, VpnLocation, VpnState } from '@contracts'

import { FridayLogger } from './logger'
import { VPN_LOCATION_CATALOG, VpnConfigService } from './vpnConfigService'

const XRAY_VERSION = 'v26.3.23'
const XRAY_DOWNLOAD_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-windows-64.zip`
const XRAY_START_TIMEOUT_MS = 45_000
const TUN_READY_TIMEOUT_MS = 25_000

type PrimaryNetworkInfo = {
  interfaceAlias: string
  interfaceIndex: number
  localAddress: string
  gateway: string
}

type TunNetworkInfo = {
  interfaceAlias: string
  interfaceIndex: number
  address: string
}

export class VpnRuntimeService {
  private vpnProcess: ChildProcessWithoutNullStreams | null = null
  private connectPromise: Promise<VpnState> | null = null
  private state: VpnState = createDefaultState()
  private readonly stateDir: string
  private readonly runtimeDir: string
  private readonly runtimeZipPath: string
  private readonly runtimeConfigPath: string
  private readonly configService: VpnConfigService
  private readonly logger: FridayLogger
  private lastPrimaryRoute: PrimaryNetworkInfo | null = null
  private lastTunRoute: TunNetworkInfo | null = null
  private lastServerAddress: string | null = null

  constructor(userDataPath: string, configService: VpnConfigService, logger: FridayLogger) {
    this.stateDir = path.join(userDataPath, 'vpn')
    this.runtimeDir = path.join(this.stateDir, 'xray-core')
    this.runtimeZipPath = path.join(this.stateDir, 'xray-core.zip')
    this.runtimeConfigPath = path.join(this.stateDir, 'xray-tun.json')
    this.configService = configService
    this.logger = logger
  }

  async getConfig(): Promise<VpnConfig> {
    return this.configService.load()
  }

  async saveConfig(config: VpnConfig): Promise<VpnConfig> {
    const saved = await this.configService.save(config)
    const summary = summarizeProfile(saved.rawProfileJson)
    this.state = {
      ...this.state,
      mode: saved.mode,
      profileName: summary.profileName,
      locationId: saved.locationId,
      serverAddress: summary.serverAddress,
      serverPort: summary.serverPort,
    }
    return saved
  }

  async listLocations(): Promise<VpnLocation[]> {
    return VPN_LOCATION_CATALOG
  }

  async getState(): Promise<VpnState> {
    const config = await this.configService.load()
    const summary = summarizeProfile(config.rawProfileJson)
    const runtimeInstalled = await this.isRuntimeInstalled()
    const requiresAdmin = !(await isElevated())

    this.state = {
      ...this.state,
      mode: config.mode,
      locationId: config.locationId,
      profileName: summary.profileName,
      serverAddress: summary.serverAddress,
      serverPort: summary.serverPort,
      runtimeInstalled,
      requiresAdmin,
      enabled: this.state.status === 'connected' || this.state.status === 'connecting',
    }

    return this.state
  }

  async connect(): Promise<VpnState> {
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  async disconnect(): Promise<VpnState> {
    const current = await this.getState()
    if (current.status === 'disconnected') {
      return current
    }

    this.state = {
      ...current,
      status: 'disconnecting',
      detail: 'Stopping VPN runtime...',
      enabled: false,
    }

    await this.cleanupRoutes().catch(async (error) => {
      await this.logger.error(`Failed to clean VPN routes: ${formatError(error)}`)
    })

    if (this.vpnProcess) {
      const processToStop = this.vpnProcess
      this.vpnProcess = null
      processToStop.kill()
    }

    this.state = {
      ...this.state,
      status: 'disconnected',
      detail: 'VPN is turned off.',
      connectedAt: null,
      lastError: null,
      enabled: false,
    }

    return this.state
  }

  private async connectInternal(): Promise<VpnState> {
    const config = await this.configService.load()
    const summary = summarizeProfile(config.rawProfileJson)
    const requiresAdmin = !(await isElevated())
    if (requiresAdmin) {
      this.state = {
        ...this.state,
        mode: config.mode,
        status: 'error',
        enabled: false,
        requiresAdmin: true,
        runtimeInstalled: await this.isRuntimeInstalled(),
        detail: 'TUN mode needs Friday to be started as Administrator.',
        lastError: 'Administrator privileges are required for TUN mode.',
        locationId: config.locationId,
        profileName: summary.profileName,
        serverAddress: summary.serverAddress,
        serverPort: summary.serverPort,
      }
      return this.state
    }

    await this.disconnect()

    this.state = {
      ...this.state,
      mode: config.mode,
      locationId: config.locationId,
      status: 'connecting',
      enabled: true,
      requiresAdmin: false,
      runtimeInstalled: await this.isRuntimeInstalled(),
      detail: 'Preparing VPN runtime...',
      lastError: null,
      profileName: summary.profileName,
      serverAddress: summary.serverAddress,
      serverPort: summary.serverPort,
    }

    const runtime = await this.ensureRuntimeInstalled()
    this.state = {
      ...this.state,
      runtimeInstalled: true,
      detail: 'Building TUN configuration...',
    }

    const primaryNetwork = await getPrimaryNetworkInfo()
    this.lastPrimaryRoute = primaryNetwork
    this.lastServerAddress = summary.serverAddress
    const runtimeConfig = buildTunRuntimeConfig(config, summary.serverAddress, primaryNetwork)

    await mkdir(this.stateDir, { recursive: true })
    await writeFile(this.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8')

    await this.startXray(runtime.xrayPath)

    this.state = {
      ...this.state,
      detail: 'Waiting for TUN interface...',
    }

    const tunNetwork = await waitForTunInterface(config.tunInterfaceName, TUN_READY_TIMEOUT_MS)
    this.lastTunRoute = tunNetwork

    await ensureRoute({
      destinationPrefix: '0.0.0.0/0',
      interfaceIndex: tunNetwork.interfaceIndex,
      nextHop: tunNetwork.address,
      metric: 5,
    })

    if (summary.serverAddress) {
      await ensureRoute({
        destinationPrefix: `${summary.serverAddress}/32`,
        interfaceIndex: primaryNetwork.interfaceIndex,
        nextHop: primaryNetwork.gateway,
        metric: 3,
      })
    }

    this.state = {
      ...this.state,
      status: 'connected',
      enabled: true,
      detail: `VPN connected in TUN mode via ${summary.profileName}.`,
      connectedAt: new Date().toISOString(),
      lastError: null,
    }

    return this.state
  }

  private async ensureRuntimeInstalled(): Promise<{ xrayPath: string }> {
    const xrayPath = path.join(this.runtimeDir, 'xray.exe')
    if (await pathExists(xrayPath)) {
      return { xrayPath }
    }

    await mkdir(this.stateDir, { recursive: true })
    await this.logger.info(`Downloading Xray runtime ${XRAY_VERSION} from ${XRAY_DOWNLOAD_URL}`)

    const response = await fetch(XRAY_DOWNLOAD_URL, {
      headers: {
        'User-Agent': 'Friday-VPN',
      },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      throw new Error(`Failed to download Xray runtime: HTTP ${response.status}`)
    }

    const archiveBuffer = Buffer.from(await response.arrayBuffer())
    await writeFile(this.runtimeZipPath, archiveBuffer)
    await rm(this.runtimeDir, { recursive: true, force: true })
    await mkdir(this.runtimeDir, { recursive: true })
    new AdmZip(this.runtimeZipPath).extractAllTo(this.runtimeDir, true)

    if (!(await pathExists(xrayPath))) {
      throw new Error('Xray runtime was downloaded but xray.exe is missing.')
    }

    return { xrayPath }
  }

  private async isRuntimeInstalled(): Promise<boolean> {
    return pathExists(path.join(this.runtimeDir, 'xray.exe'))
  }

  private async startXray(xrayPath: string): Promise<void> {
    let startupError: Error | null = null

    await this.logger.info(`Starting Xray VPN runtime from ${xrayPath}`)
    this.vpnProcess = spawn(xrayPath, ['run', '-config', this.runtimeConfigPath], {
      cwd: this.runtimeDir,
      windowsHide: true,
      stdio: 'pipe',
    })

    this.vpnProcess.stdout.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        void this.logger.info(`[vpn] ${text}`)
      }
    })
    this.vpnProcess.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        void this.logger.error(`[vpn] ${text}`)
      }
    })
    this.vpnProcess.once('error', (error) => {
      startupError = error instanceof Error ? error : new Error(String(error))
      this.vpnProcess = null
    })
    this.vpnProcess.once('exit', (code) => {
      void this.logger.info(`VPN runtime exited with code ${code ?? 'unknown'}`)
      this.vpnProcess = null
      if (this.state.status === 'connected' || this.state.status === 'connecting') {
        this.state = {
          ...this.state,
          status: 'error',
          enabled: false,
          detail: 'VPN runtime exited unexpectedly.',
          connectedAt: null,
          lastError: `VPN runtime exited with code ${code ?? 'unknown'}.`,
        }
      }
      void this.cleanupRoutes().catch(() => {})
    })

    const deadline = Date.now() + XRAY_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (startupError) {
        throw startupError
      }

      if (!this.vpnProcess) {
        throw new Error('VPN runtime exited before it became ready.')
      }

      await delay(500)
      if (await pathExists(this.runtimeConfigPath)) {
        return
      }
    }

    throw new Error(`VPN runtime did not become ready within ${XRAY_START_TIMEOUT_MS / 1000}s.`)
  }

  private async cleanupRoutes(): Promise<void> {
    if (this.lastTunRoute) {
      await removeRoute({
        destinationPrefix: '0.0.0.0/0',
        interfaceIndex: this.lastTunRoute.interfaceIndex,
        nextHop: this.lastTunRoute.address,
      })
      this.lastTunRoute = null
    }

    if (this.lastPrimaryRoute && this.lastServerAddress) {
      await removeRoute({
        destinationPrefix: `${this.lastServerAddress}/32`,
        interfaceIndex: this.lastPrimaryRoute.interfaceIndex,
        nextHop: this.lastPrimaryRoute.gateway,
      })
    }
  }
}

function createDefaultState(): VpnState {
  return {
    status: 'disconnected',
    enabled: false,
    mode: 'tun',
    detail: 'VPN is turned off.',
    requiresAdmin: false,
    runtimeInstalled: false,
    connectedAt: null,
    lastError: null,
    profileName: 'VPN profile',
    locationId: 'usa-new-jersey',
    serverAddress: null,
    serverPort: null,
  }
}

function summarizeProfile(rawProfileJson: string): {
  profileName: string
  serverAddress: string | null
  serverPort: number | null
} {
  try {
    const parsed = JSON.parse(rawProfileJson) as {
      remarks?: string
      outbounds?: Array<{ tag?: string; settings?: { vnext?: Array<{ address?: string; port?: number }> } }>
    }
    const proxyOutbound = parsed.outbounds?.find((outbound) => outbound.tag === 'proxy') ?? parsed.outbounds?.[0]
    const endpoint = proxyOutbound?.settings?.vnext?.[0]
    return {
      profileName: parsed.remarks?.trim() || 'VPN profile',
      serverAddress: endpoint?.address?.trim() || null,
      serverPort: typeof endpoint?.port === 'number' ? endpoint.port : null,
    }
  } catch {
    return {
      profileName: 'VPN profile',
      serverAddress: null,
      serverPort: null,
    }
  }
}

function buildTunRuntimeConfig(config: VpnConfig, serverAddress: string | null, network: PrimaryNetworkInfo) {
  const base = JSON.parse(config.rawProfileJson) as Record<string, unknown>
  const baseOutbounds = Array.isArray(base.outbounds) ? structuredClone(base.outbounds) : []
  const routedOutbounds = baseOutbounds.map((outbound) => applySendThrough(outbound, network.localAddress))
  const baseRules = extractRoutingRules(base.routing)
    .filter((rule) => !hasInboundTag(rule, 'socks'))
    .filter((rule) => !hasInboundTag(rule, 'http'))

  const rules: Array<Record<string, unknown>> = []

  if (serverAddress) {
    rules.push({
      ip: [serverAddress],
      outboundTag: 'direct',
    })
  }

  rules.push(
    {
      inboundTag: ['tun-in'],
      port: '53',
      outboundTag: 'direct',
    },
    ...baseRules,
    {
      inboundTag: ['tun-in'],
      outboundTag: 'proxy',
    },
  )

  return {
    log: base.log ?? {
      loglevel: 'warning',
    },
    dns: base.dns ?? undefined,
    metrics: base.metrics ?? undefined,
    policy: base.policy ?? undefined,
    stats: base.stats ?? undefined,
    inbounds: [
      {
        tag: 'tun-in',
        protocol: 'tun',
        settings: {
          name: config.tunInterfaceName,
          mtu: config.mtu,
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls', 'quic'],
        },
      },
    ],
    outbounds: routedOutbounds,
    routing: {
      domainStrategy: readRoutingDomainStrategy(base.routing),
      rules,
    },
  }
}

function applySendThrough(outbound: unknown, localAddress: string) {
  if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound)) {
    return outbound
  }

  const record = structuredClone(outbound) as Record<string, unknown>
  if (typeof record.protocol === 'string' && ['vless', 'freedom', 'blackhole'].includes(record.protocol)) {
    record.sendThrough = localAddress
  }
  return record
}

function extractRoutingRules(routing: unknown): Array<Record<string, unknown>> {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return []
  }

  const rules = (routing as { rules?: unknown }).rules
  if (!Array.isArray(rules)) {
    return []
  }

  return rules.filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === 'object' && !Array.isArray(rule))
}

function readRoutingDomainStrategy(routing: unknown): string {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return 'IPIfNonMatch'
  }

  const value = (routing as { domainStrategy?: unknown }).domainStrategy
  return typeof value === 'string' && value.trim() ? value : 'IPIfNonMatch'
}

function hasInboundTag(rule: Record<string, unknown>, target: string): boolean {
  const inboundTag = rule.inboundTag
  return Array.isArray(inboundTag) && inboundTag.some((entry) => String(entry) === target)
}

async function getPrimaryNetworkInfo(): Promise<PrimaryNetworkInfo> {
  const raw = await runPowerShell(`
$cfg = Get-NetIPConfiguration |
  Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } |
  Select-Object -First 1
if (-not $cfg) { throw 'No active IPv4 default route was found.' }
$ip = $cfg.IPv4Address | Select-Object -First 1
if (-not $ip) { throw 'No IPv4 address was found for the active route.' }
[pscustomobject]@{
  interfaceAlias = $cfg.InterfaceAlias
  interfaceIndex = $cfg.InterfaceIndex
  localAddress = $ip.IPAddress
  gateway = $cfg.IPv4DefaultGateway.NextHop
} | ConvertTo-Json -Compress
`)

  return JSON.parse(raw) as PrimaryNetworkInfo
}

async function waitForTunInterface(interfaceAlias: string, timeoutMs: number): Promise<TunNetworkInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await runPowerShell(`
$cfg = Get-NetIPConfiguration -InterfaceAlias '${escapePowerShellString(interfaceAlias)}' -ErrorAction Stop
$ip = $cfg.IPv4Address | Select-Object -First 1
if (-not $ip) { throw 'IPv4 address is not assigned yet.' }
[pscustomobject]@{
  interfaceAlias = $cfg.InterfaceAlias
  interfaceIndex = $cfg.InterfaceIndex
  address = $ip.IPAddress
} | ConvertTo-Json -Compress
`)
      return JSON.parse(raw) as TunNetworkInfo
    } catch {
      await delay(1_000)
    }
  }

  throw new Error(`Timed out waiting for TUN interface "${interfaceAlias}".`)
}

async function ensureRoute(input: {
  destinationPrefix: string
  interfaceIndex: number
  nextHop: string
  metric: number
}): Promise<void> {
  await runPowerShell(`
$existing = Get-NetRoute -DestinationPrefix '${escapePowerShellString(input.destinationPrefix)}' -InterfaceIndex ${input.interfaceIndex} -ErrorAction SilentlyContinue |
  Where-Object { $_.NextHop -eq '${escapePowerShellString(input.nextHop)}' }
if (-not $existing) {
  New-NetRoute -DestinationPrefix '${escapePowerShellString(input.destinationPrefix)}' -InterfaceIndex ${input.interfaceIndex} -NextHop '${escapePowerShellString(input.nextHop)}' -RouteMetric ${input.metric} -PolicyStore ActiveStore | Out-Null
}
`)
}

async function removeRoute(input: {
  destinationPrefix: string
  interfaceIndex: number
  nextHop: string
}): Promise<void> {
  await runPowerShell(`
$existing = Get-NetRoute -DestinationPrefix '${escapePowerShellString(input.destinationPrefix)}' -InterfaceIndex ${input.interfaceIndex} -ErrorAction SilentlyContinue |
  Where-Object { $_.NextHop -eq '${escapePowerShellString(input.nextHop)}' }
if ($existing) {
  $existing | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
}
`)
}

async function isElevated(): Promise<boolean> {
  try {
    const raw = await runPowerShell(`
[bool](([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) | ConvertTo-Json -Compress
`)
    return JSON.parse(raw) === true
  } catch {
    return false
  }
}

async function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', (error) => {
      reject(error)
    })
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code ?? 'unknown'}.`))
    })
  })
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''")
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
