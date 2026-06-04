import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { VpnConfig, VpnLocation } from '@contracts'

const DEFAULT_PROFILE = {
  dns: {
    hosts: {
      'domain:googleapis.cn': 'googleapis.com',
    },
    queryStrategy: 'UseIPv4',
    servers: [
      '1.1.1.1',
      {
        address: '1.1.1.1',
        domains: [],
        port: 53,
      },
      {
        address: '8.8.8.8',
        domains: [],
        port: 53,
      },
    ],
  },
  log: {
    loglevel: 'warning',
  },
  metrics: {
    tag: 'metrics_out',
  },
  outbounds: [
    {
      mux: {
        concurrency: -1,
        enabled: false,
        xudpConcurrency: 8,
        xudpProxyUDP443: '',
      },
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: '45.139.50.23',
            port: 2053,
            users: [
              {
                encryption: 'none',
                flow: 'xtls-rprx-vision',
                id: 'b921e031-6c8c-400f-b740-2cd801bb658c',
                level: 8,
                security: 'auto',
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: 'tcp',
        realitySettings: {
          allowInsecure: false,
          fingerprint: 'chrome',
          publicKey: 'WckOSneVajAzpH0sZSAFAWPnmwuuEXKZrTICNj5_hHU',
          serverName: 'www.ibm.com',
          shortId: '423bccc9c13fb509',
          show: false,
          spiderX: '/',
        },
        security: 'reality',
        tcpSettings: {
          header: {
            type: 'none',
          },
        },
      },
      tag: 'proxy',
    },
    {
      protocol: 'freedom',
      settings: {
        domainStrategy: 'UseIP',
      },
      tag: 'direct',
    },
    {
      protocol: 'blackhole',
      settings: {
        response: {
          type: 'http',
        },
      },
      tag: 'block',
    },
  ],
  policy: {
    levels: {
      '0': {
        statsUserDownlink: true,
        statsUserUplink: true,
      },
      '8': {
        connIdle: 300,
        downlinkOnly: 1,
        handshake: 4,
        uplinkOnly: 1,
      },
    },
    system: {
      statsInboundDownlink: true,
      statsInboundUplink: true,
      statsOutboundDownlink: true,
      statsOutboundUplink: true,
    },
  },
  remarks: 'USA [New Jersey]',
  routing: {
    domainStrategy: 'IPIfNonMatch',
    rules: [
      {
        ip: ['1.1.1.1'],
        outboundTag: 'direct',
        port: '53',
      },
      {
        ip: ['8.8.8.8'],
        outboundTag: 'direct',
        port: '53',
      },
    ],
  },
  stats: {},
}

const DEFAULT_VPN_CONFIG: VpnConfig = {
  mode: 'tun',
  autoConnect: false,
  profileSource: 'catalog',
  locationId: 'usa-new-jersey',
  tunInterfaceName: 'FridayTun',
  mtu: 1500,
  rawProfileJson: `${JSON.stringify(DEFAULT_PROFILE, null, 2)}\n`,
}

const DEFAULT_VPN_ENDPOINT = DEFAULT_PROFILE.outbounds[0]?.settings.vnext?.[0]

export const VPN_LOCATION_CATALOG: VpnLocation[] = [
  {
    id: 'usa-new-jersey',
    name: 'USA, New Jersey',
    countryCode: 'US',
    city: 'New Jersey',
    profileName: DEFAULT_PROFILE.remarks,
    serverAddress: DEFAULT_VPN_ENDPOINT?.address ?? '45.33.247.61',
    serverPort: DEFAULT_VPN_ENDPOINT?.port ?? 443,
    rawProfileJson: DEFAULT_VPN_CONFIG.rawProfileJson,
  },
]

export class VpnConfigService {
  private readonly configPath: string

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, 'state', 'vpn-config.json')
  }

  async load(): Promise<VpnConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<VpnConfig>
      return normalizeVpnConfig(parsed)
    } catch {
      return DEFAULT_VPN_CONFIG
    }
  }

  async save(config: VpnConfig): Promise<VpnConfig> {
    const normalized = normalizeVpnConfig(config)
    await mkdir(path.dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }
}

function normalizeVpnConfig(input: Partial<VpnConfig> | null | undefined): VpnConfig {
  const mode = input?.mode === 'tun' ? 'tun' : DEFAULT_VPN_CONFIG.mode
  const autoConnect = Boolean(input?.autoConnect)
  const profileSource = input?.profileSource === 'manual' ? 'manual' : 'catalog'
  const catalogLocation = resolveCatalogLocation(input?.locationId)
  const locationId = profileSource === 'catalog' ? catalogLocation.id : input?.locationId?.trim() || 'manual'
  const tunInterfaceName = normalizeNonEmptyString(input?.tunInterfaceName, DEFAULT_VPN_CONFIG.tunInterfaceName)
  const mtu = normalizeMtu(input?.mtu)
  const rawProfileJson = normalizeProfileJson(
    profileSource === 'catalog' ? catalogLocation.rawProfileJson : input?.rawProfileJson,
  )

  return {
    mode,
    autoConnect,
    profileSource,
    locationId,
    tunInterfaceName,
    mtu,
    rawProfileJson,
  }
}

function resolveCatalogLocation(locationId: string | undefined): VpnLocation {
  return VPN_LOCATION_CATALOG.find((location) => location.id === locationId) ?? VPN_LOCATION_CATALOG[0]
}

function normalizeProfileJson(value: string | undefined): string {
  const fallback = DEFAULT_VPN_CONFIG.rawProfileJson
  const trimmed = value?.trim()
  if (!trimmed) {
    return fallback
  }

  try {
    const parsed = JSON.parse(trimmed)
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return `${trimmed}\n`
  }
}

function normalizeMtu(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_VPN_CONFIG.mtu
  }

  return Math.min(9000, Math.max(1280, Math.round(value)))
}

function normalizeNonEmptyString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}
