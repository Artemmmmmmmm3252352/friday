import { access, readdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()

const requiredFiles = [
  ['OpenClaw CLI', 'vendor/openclaw-runtime/node_modules/openclaw/openclaw.mjs'],
  ['OpenClaw package', 'vendor/openclaw-runtime/node_modules/openclaw/package.json'],
  ['Bundled Node', 'vendor/openclaw-runtime/node.bin'],
  ['Friday backend plugin', 'openclaw-plugins/friday-backend/index.js'],
  ['Friday backend server', 'dist-server/apps/api/src/server.js'],
  ['Friday backend Fastify dependency', 'vendor/backend-node_modules/fastify/package.json'],
  ['Friday backend Postgres dependency', 'vendor/backend-node_modules/pg/package.json'],
  ['Friday runtime env', 'vendor/friday-runtime.env'],
  ['Portable Python', 'vendor/portable-python/python.exe'],
  ['Voice runtime requirements', 'voice-runtime/requirements.txt'],
  ['BeamNG bridge requirements', 'beamng-bridge/requirements.txt'],
]

for (const [label, relativePath] of requiredFiles) {
  await assertFile(label, path.join(projectRoot, relativePath))
}

await assertNonEmptyDirectory('OpenClaw plugins', path.join(projectRoot, 'openclaw-plugins'))
await assertNonEmptyDirectory('Sherpa model', path.join(projectRoot, 'vendor', 'sherpa-model'))
await assertEnvKey('Friday runtime env', path.join(projectRoot, 'vendor', 'friday-runtime.env'), 'FRIDAY_DATABASE_URL')

console.log('Installer assets verified.')

async function assertFile(label, targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
  } catch {
    throw new Error(`${label} is missing: ${targetPath}`)
  }
}

async function assertNonEmptyDirectory(label, targetPath) {
  const entries = await readdir(targetPath).catch(() => [])
  if (entries.length === 0) {
    throw new Error(`${label} directory is missing or empty: ${targetPath}`)
  }
}

async function assertEnvKey(label, targetPath, key) {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(targetPath, 'utf8')
  if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(raw)) {
    throw new Error(`${label} is missing ${key}: ${targetPath}`)
  }
}
