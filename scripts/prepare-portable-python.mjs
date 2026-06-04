import { access, cp, mkdir, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const projectRoot = process.cwd()
const targetRoot = path.join(projectRoot, 'vendor', 'portable-python')

const sourceRoot = await resolvePythonBasePrefix()
await rm(targetRoot, { recursive: true, force: true })
await mkdir(path.dirname(targetRoot), { recursive: true })
await cp(sourceRoot, targetRoot, {
  recursive: true,
  filter: (source) => !shouldSkip(source),
})

await assertFile(path.join(targetRoot, 'python.exe'))
console.log(`Portable Python prepared: ${targetRoot}`)

async function resolvePythonBasePrefix() {
  const output = await run('python', ['-c', 'import sys; print(sys.base_prefix)'])
  const basePrefix = output.trim()
  if (!basePrefix) {
    throw new Error('Unable to resolve Python base_prefix.')
  }
  await assertFile(path.join(basePrefix, 'python.exe'))
  return basePrefix
}

function shouldSkip(source) {
  const normalized = source.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/__pycache__') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/site-packages/pip/_vendor/cachecontrol/caches/')
  )
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr}`))
      }
    })
    child.once('error', reject)
  })
}

async function assertFile(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
  } catch {
    throw new Error(`Required file is missing: ${targetPath}`)
  }
}
