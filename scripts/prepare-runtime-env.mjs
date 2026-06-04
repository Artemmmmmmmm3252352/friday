import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = process.cwd()
const sourcePath = path.join(projectRoot, '.env.local')
const targetPath = path.join(projectRoot, 'vendor', 'friday-runtime.env')
const requiredKeys = ['FRIDAY_DATABASE_URL']
const optionalKeys = ['MUSIC_PROVIDER_CLIENT_ID', 'MUSIC_PROVIDER_CLIENT_SECRET', 'YOUTUBE_DATA_API_KEY']

const source = await readFile(sourcePath, 'utf8')
const values = parseEnv(source)
const managedNvidiaKey = await resolveManagedNvidiaKey(values)

for (const key of requiredKeys) {
  if (!values.get(key)) {
    throw new Error(`Missing required ${key} in ${sourcePath}`)
  }
}

const lines = []
for (const key of [...requiredKeys, ...optionalKeys]) {
  const value = values.get(key)
  if (value) {
    lines.push(`${key}=${value}`)
  }
}

if (managedNvidiaKey) {
  lines.push(`FRIDAY_MANAGED_NVIDIA_API_KEY=${managedNvidiaKey}`)
  lines.push(`NVIDIA_API_KEY=${managedNvidiaKey}`)
}

await mkdir(path.dirname(targetPath), { recursive: true })
await writeFile(targetPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`Runtime env prepared: ${targetPath}`)

function parseEnv(raw) {
  const values = new Map()
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    values.set(trimmed.slice(0, separatorIndex).trim(), stripOptionalQuotes(trimmed.slice(separatorIndex + 1).trim()))
  }
  return values
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

async function resolveManagedNvidiaKey(sourceValues) {
  const envKey =
    process.env.FRIDAY_MANAGED_NVIDIA_API_KEY ||
    process.env.NVIDIA_API_KEY ||
    sourceValues.get('FRIDAY_MANAGED_NVIDIA_API_KEY') ||
    sourceValues.get('NVIDIA_API_KEY') ||
    // Backward-compatible fallback only for one migration build. The generated
    // runtime env is always NVIDIA-based, so fresh installs no longer depend on Groq.
    process.env.FRIDAY_MANAGED_GROQ_API_KEY ||
    process.env.GROQ_API_KEY ||
    sourceValues.get('FRIDAY_MANAGED_GROQ_API_KEY') ||
    sourceValues.get('GROQ_API_KEY')
  if (envKey) {
    return envKey
  }

  const openClawEnv = await readOptionalFile(path.join(os.homedir(), '.openclaw', '.env'))
  const openClawValues = parseEnv(openClawEnv)
  const openClawEnvKey =
    openClawValues.get('FRIDAY_MANAGED_NVIDIA_API_KEY') ||
    openClawValues.get('NVIDIA_API_KEY') ||
    openClawValues.get('FRIDAY_MANAGED_GROQ_API_KEY') ||
    openClawValues.get('GROQ_API_KEY')
  if (openClawEnvKey) {
    return openClawEnvKey
  }

  const authProfilesRaw = await readOptionalFile(path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'))
  try {
    const authProfiles = JSON.parse(authProfilesRaw)
    const profiles = authProfiles && typeof authProfiles === 'object' ? authProfiles.profiles : null
    const nvidiaDefault = profiles && typeof profiles === 'object' ? profiles['nvidia:default'] : null
    const groqDefault = profiles && typeof profiles === 'object' ? profiles['groq:default'] : null
    const key =
      nvidiaDefault && typeof nvidiaDefault === 'object'
        ? nvidiaDefault.key
        : groqDefault && typeof groqDefault === 'object'
          ? groqDefault.key
          : ''
    return typeof key === 'string' ? key.trim() : ''
  } catch {
    return ''
  }
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}
