import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { SystemSnapshot } from '../../src/shared/contracts'

const execFileAsync = promisify(execFile)

interface CpuSample {
  idle: number
  total: number
}

export class SystemMetricsService {
  async getSnapshot(): Promise<SystemSnapshot> {
    const [cpuPercent, gpuPercent] = await Promise.all([this.getCpuPercent(), this.getGpuPercent()])
    const totalMemory = os.totalmem()
    const usedMemory = totalMemory - os.freemem()
    const ramPercent = totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0

    return {
      cpuPercent,
      ramPercent,
      ramUsedGb: roundToSingleDecimal(usedMemory / 1024 / 1024 / 1024),
      ramTotalGb: roundToSingleDecimal(totalMemory / 1024 / 1024 / 1024),
      gpuPercent,
    }
  }

  private async getCpuPercent() {
    const start = sampleCpu()
    await delay(180)
    const end = sampleCpu()
    const idle = end.idle - start.idle
    const total = end.total - start.total

    if (total <= 0) {
      return 0
    }

    return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)))
  }

  private async getGpuPercent() {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "$samples = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples; $sum = ($samples | Measure-Object -Property CookedValue -Sum).Sum; if ($null -eq $sum) { $sum = 0 }; [Console]::Write([math]::Round([math]::Min($sum, 100), 0))",
        ],
        {
          windowsHide: true,
          timeout: 4000,
          maxBuffer: 1024 * 1024,
        },
      )

      const parsed = Number.parseInt(stdout.trim(), 10)
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(100, parsed))
      }
    } catch {
      return null
    }

    return null
  }
}

function sampleCpu(): CpuSample {
  return os.cpus().reduce(
    (accumulator, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
      return {
        idle: accumulator.idle + cpu.times.idle,
        total: accumulator.total + total,
      }
    },
    { idle: 0, total: 0 },
  )
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10
}
