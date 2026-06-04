import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ENV_FILES = ['.env.local', '.env']

export function loadRuntimeEnv(baseEnv: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  const mergedEnv: NodeJS.ProcessEnv = { ...baseEnv }

  for (const fileName of ENV_FILES) {
    const filePath = path.join(cwd, fileName)
    if (!existsSync(filePath)) {
      continue
    }

    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/u)) {
      const trimmedLine = line.trim()
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue
      }

      const separatorIndex = trimmedLine.indexOf('=')
      if (separatorIndex <= 0) {
        continue
      }

      const key = trimmedLine.slice(0, separatorIndex).trim()
      if (!key || mergedEnv[key]) {
        continue
      }

      const rawValue = trimmedLine.slice(separatorIndex + 1).trim()
      mergedEnv[key] = stripOptionalQuotes(rawValue)
    }
  }

  return mergedEnv
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}
