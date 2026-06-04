import { createWriteStream } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MODEL_ARCHIVE_NAME = 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16.tar.bz2'
const MODEL_DIR_NAME = 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE_NAME}`

const projectRoot = process.cwd()
const vendorRoot = path.join(projectRoot, 'vendor', 'sherpa-model')
const archivePath = path.join(vendorRoot, MODEL_ARCHIVE_NAME)
const extractedModelDir = path.join(vendorRoot, MODEL_DIR_NAME)

await mkdir(vendorRoot, { recursive: true })

if (await hasModelPayload(extractedModelDir)) {
  console.log(`[prepare-whisper-model] Using cached ASR model from ${extractedModelDir}`)
  process.exit(0)
}

try {
  await rm(archivePath, { force: true })
  await rm(extractedModelDir, { recursive: true, force: true })
  await downloadModelArchive()
  await extractModelArchive()

  if (!(await hasModelPayload(extractedModelDir))) {
    throw new Error(`Extracted model payload is incomplete in ${extractedModelDir}`)
  }
} catch (error) {
  console.warn(
    `[prepare-whisper-model] Failed to bundle local ASR model. Packaging will continue and Friday will download the model on first voice use. ${String(error)}`,
  )
}

async function downloadModelArchive() {
  try {
    const response = await fetch(MODEL_URL)
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${MODEL_URL}`)
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath))
    return
  } catch (error) {
    console.warn(`[prepare-whisper-model] fetch() download failed, falling back to curl.exe. ${String(error)}`)
  }

  await new Promise((resolve, reject) => {
    const child = spawn('curl.exe', ['-L', '--fail', '--output', archivePath, MODEL_URL], {
      windowsHide: true,
      stdio: 'inherit',
    })

    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`curl.exe exited with code ${code ?? 'unknown'}`))
    })

    child.once('error', reject)
  })
}

async function extractModelArchive() {
  await execFileAsync('tar.exe', ['-xjf', archivePath, '-C', vendorRoot], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  })
}

async function hasModelPayload(rootDir) {
  for (const requiredPath of [
    path.join(rootDir, 'tokens.txt'),
    path.join(rootDir, 'bpe.model'),
    path.join(rootDir, 'decoder.onnx'),
    path.join(rootDir, 'encoder.int8.onnx'),
    path.join(rootDir, 'joiner.int8.onnx'),
  ]) {
    if (!(await exists(requiredPath))) {
      return false
    }
  }

  return true
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}
