import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import AdmZip from 'adm-zip'

const projectRoot = process.cwd()
const runtimeRoot = path.join(projectRoot, 'vendor', 'openclaw-runtime')
const runtimeArchivePath = path.join(projectRoot, 'vendor', 'openclaw-runtime.zip')

await rm(runtimeRoot, { recursive: true, force: true })
await rm(runtimeArchivePath, { force: true })
await mkdir(runtimeRoot, { recursive: true })

await writeFile(
  path.join(runtimeRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'friday-openclaw-runtime',
      private: true,
      version: '1.0.0',
      description: 'Bundled OpenClaw runtime for Friday desktop builds',
      dependencies: {
        openclaw: '2026.3.13',
        'playwright-core': '^1.59.1',
      },
    },
    null,
    2,
  ),
  'utf8',
)

await run('npm.cmd', ['install', '--omit=dev'], runtimeRoot)
await assertRuntimeBuildOutput(runtimeRoot)
await copyFile(process.execPath, path.join(runtimeRoot, 'node.bin'))

const archive = new AdmZip()
archive.addLocalFolder(runtimeRoot)
assertArchiveContainsRuntimeBuildOutput(archive)
archive.writeZip(runtimeArchivePath)

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', command, ...args], {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    })

    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })

    child.once('error', reject)
  })
}

async function assertRuntimeBuildOutput(runtimeDir) {
  const requiredPaths = [
    path.join(runtimeDir, 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(runtimeDir, 'node_modules', 'openclaw', 'package.json'),
    path.join(runtimeDir, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'),
  ]

  let hasEntryFile = false
  for (const candidate of ['entry.js', 'entry.mjs']) {
    if (await exists(path.join(runtimeDir, 'node_modules', 'openclaw', 'dist', candidate))) {
      hasEntryFile = true
      break
    }
  }

  if (!hasEntryFile) {
    throw new Error('Bundled OpenClaw runtime is missing dist/entry.(m)js after npm install.')
  }

  for (const requiredPath of requiredPaths) {
    if (!(await exists(requiredPath))) {
      throw new Error(`Bundled OpenClaw runtime is missing required file: ${requiredPath}`)
    }
  }
}

function assertArchiveContainsRuntimeBuildOutput(archive) {
  const entryNames = new Set(archive.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')))
  const hasEntryFile =
    entryNames.has('node_modules/openclaw/dist/entry.js') || entryNames.has('node_modules/openclaw/dist/entry.mjs')

  if (!hasEntryFile) {
    throw new Error('Bundled OpenClaw runtime archive is missing dist/entry.(m)js.')
  }

  for (const requiredPath of [
    'node_modules/openclaw/openclaw.mjs',
    'node_modules/openclaw/package.json',
    'node_modules/@anthropic-ai/sdk/package.json',
    'node.bin',
  ]) {
    if (!entryNames.has(requiredPath)) {
      throw new Error(`Bundled OpenClaw runtime archive is missing required file: ${requiredPath}`)
    }
  }
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}
