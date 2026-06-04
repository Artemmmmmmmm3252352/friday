import { cp, lstat, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const projectRoot = process.cwd()
const outputRoot = path.join(projectRoot, 'vendor', 'backend-node_modules')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

const npmLsRaw = readProductionDependencyTree()

const tree = JSON.parse(npmLsRaw)
const packageNames = new Set()
collectPackageNames(tree.dependencies)

for (const packageName of [...packageNames].sort()) {
  const sourcePath = path.join(projectRoot, 'node_modules', ...packageName.split('/'))
  if (!existsSync(sourcePath)) {
    continue
  }

  const stats = await lstat(sourcePath)
  if (stats.isSymbolicLink()) {
    continue
  }

  const targetPath = path.join(outputRoot, ...packageName.split('/'))
  await mkdir(path.dirname(targetPath), { recursive: true })
  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => !shouldSkip(source),
  })
}

console.log(`Backend runtime dependencies prepared: ${packageNames.size} packages`)

function collectPackageNames(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    packageNames.add(name)
    collectPackageNames(dependency.dependencies)
  }
}

function readProductionDependencyTree() {
  try {
    return execSync('npm ls --omit=dev --all --json', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error?.stdout) {
      return String(error.stdout)
    }

    throw error
  }
}

function shouldSkip(source) {
  const normalized = source.replaceAll('\\', '/')
  return (
    normalized.includes('/.git/') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/docs/') ||
    normalized.endsWith('/.git') ||
    normalized.endsWith('/test') ||
    normalized.endsWith('/tests') ||
    normalized.endsWith('/docs')
  )
}
