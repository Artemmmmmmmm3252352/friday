import { access, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const projectRoot = process.cwd()
const releaseDir = path.join(projectRoot, 'release')
const forUsersDir = path.join(releaseDir, 'for-users')
const legacyUserInstallersDir = path.join(releaseDir, 'новая для пользователей', '123')
const runtimeSourceDir = path.join(projectRoot, 'vendor', 'openclaw-runtime')
const userHomeOpenClawDir = path.join(os.homedir(), 'OpenClaw')
const pluginSourceDir = path.join(projectRoot, 'openclaw-plugins')
const stagingRoot = path.join(projectRoot, 'tmp', 'openclaw-installer')
const stagingInstallDir = path.join(stagingRoot, 'payload')
const installerScriptPath = path.join(projectRoot, 'scripts', 'openclaw-runtime-installer.nsi')

const appPackageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const appVersion =
  typeof appPackageJson.version === 'string' && appPackageJson.version.trim() ? appPackageJson.version.trim() : '0.0.0'
const runtimeSource = await resolveRuntimeSource()
const runtimePackageJson = JSON.parse(await readFile(path.join(runtimeSource.packageJsonPath), 'utf8'))
const runtimeVersion =
  typeof runtimePackageJson.version === 'string' && runtimePackageJson.version.trim()
    ? runtimePackageJson.version.trim()
    : appVersion
const installerName = `OpenClaw Setup ${runtimeVersion}.exe`
const installerOutputPath = path.join(releaseDir, installerName)
const forUsersOutputPath = path.join(forUsersDir, installerName)
const legacyUserInstallersOutputPath = path.join(legacyUserInstallersDir, installerName)

await rm(stagingRoot, { recursive: true, force: true })
await mkdir(stagingInstallDir, { recursive: true })
await cp(runtimeSource.runtimeDir, stagingInstallDir, { recursive: true, force: true })

if (await exists(pluginSourceDir)) {
  await cp(pluginSourceDir, path.join(stagingInstallDir, 'openclaw-plugins'), { recursive: true, force: true })
}

await copyFile(runtimeSource.nodeExePath, path.join(stagingInstallDir, 'node.exe'))
await writeFile(path.join(stagingInstallDir, 'openclaw.cmd'), buildWindowsWrapper(), 'utf8')
await writeFile(path.join(stagingInstallDir, 'openclaw'), buildShellWrapper(), 'utf8')

await mkdir(releaseDir, { recursive: true })
await mkdir(forUsersDir, { recursive: true })
await mkdir(legacyUserInstallersDir, { recursive: true })

const makensisPath = await findMakensis()
await run(makensisPath, [
  `/DPRODUCT_VERSION=${runtimeVersion}`,
  `/DOUTFILE=${installerOutputPath}`,
  `/DSOURCE_DIR=${stagingInstallDir}`,
  installerScriptPath,
])

await copyFile(installerOutputPath, forUsersOutputPath)
await copyFile(installerOutputPath, legacyUserInstallersOutputPath)

console.log(`OpenClaw installer created: ${installerOutputPath}`)
console.log(`Copied for users: ${forUsersOutputPath}`)
console.log(`Copied to release installer folder: ${legacyUserInstallersOutputPath}`)
console.log(`Runtime source: ${runtimeSource.runtimeDir}`)
console.log(`Runtime version: ${runtimeVersion}`)

function buildWindowsWrapper() {
  return ['@echo off', 'setlocal', '"%~dp0node.exe" "%~dp0node_modules\\openclaw\\openclaw.mjs" %*', ''].join('\r\n')
}

function buildShellWrapper() {
  return [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    '',
    'exec "$basedir/node.exe" "$basedir/node_modules/openclaw/openclaw.mjs" "$@"',
    '',
  ].join('\n')
}

async function resolveRuntimeSource() {
  if (await isRuntimeRootValid(userHomeOpenClawDir)) {
    const userHomeNodePath = (await exists(path.join(userHomeOpenClawDir, 'node.exe')))
      ? path.join(userHomeOpenClawDir, 'node.exe')
      : path.join(userHomeOpenClawDir, 'node.bin')
    return {
      runtimeDir: userHomeOpenClawDir,
      packageJsonPath: path.join(userHomeOpenClawDir, 'node_modules', 'openclaw', 'package.json'),
      nodeExePath: userHomeNodePath,
    }
  }

  await ensureFileExists(path.join(runtimeSourceDir, 'node.bin'))
  await ensureFileExists(path.join(runtimeSourceDir, 'node_modules', 'openclaw', 'openclaw.mjs'))
  return {
    runtimeDir: runtimeSourceDir,
    packageJsonPath: path.join(runtimeSourceDir, 'node_modules', 'openclaw', 'package.json'),
    nodeExePath: path.join(runtimeSourceDir, 'node.bin'),
  }
}

async function isRuntimeRootValid(rootDir) {
  const nodeCandidatePaths = [path.join(rootDir, 'node.exe'), path.join(rootDir, 'node.bin')]
  const hasNodeBinary = await Promise.all(nodeCandidatePaths.map((candidate) => exists(candidate))).then((results) =>
    results.some(Boolean),
  )

  return (
    hasNodeBinary &&
    (await exists(path.join(rootDir, 'node_modules', 'openclaw', 'openclaw.mjs'))) &&
    (await exists(path.join(rootDir, 'node_modules', 'openclaw', 'package.json')))
  )
}

async function ensureFileExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK)
  } catch {
    throw new Error(`Required file was not found: ${targetPath}`)
  }
}

async function exists(targetPath) {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function findMakensis() {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set, cannot locate makensis.exe.')
  }

  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'nsis')
  const candidates = [
    path.join(cacheRoot, 'makensis.exe'),
  ]

  let entries = []
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Unable to read NSIS cache directory: ${cacheRoot}. ${String(error)}`)
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    candidates.push(path.join(cacheRoot, entry.name, 'makensis.exe'))
    candidates.push(path.join(cacheRoot, entry.name, 'Bin', 'makensis.exe'))
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK)
      return candidate
    } catch {
      continue
    }
  }

  throw new Error(`makensis.exe was not found in ${cacheRoot}`)
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    })

    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${path.basename(command)} exited with code ${code ?? 'unknown'}`))
    })

    child.once('error', reject)
  })
}
