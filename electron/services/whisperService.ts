import { createWriteStream, existsSync } from 'node:fs'
import { access, constants, cp, mkdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

import type { DiagnosticItem } from '../../src/shared/contracts'
import { FridayLogger } from './logger'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const MODEL_ARCHIVE_NAME = 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16.tar.bz2'
const MODEL_DIR_NAME = 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE_NAME}`

type SherpaOnnxModule = {
  OnlineRecognizer: new (config: OnlineRecognizerConfig) => OnlineRecognizerLike
}

type OnlineRecognizerConfig = {
  featConfig: { sampleRate: number; featureDim: number }
  modelConfig: {
    transducer: { encoder: string; decoder: string; joiner: string }
    tokens: string
    numThreads: number
    provider: string
    modelingUnit: string
    bpeVocab: string
  }
  decodingMethod: string
  maxActivePaths: number
  enableEndpoint: number
}

type OnlineRecognizerLike = {
  createStream(): OnlineStreamLike
  isReady(stream: OnlineStreamLike): boolean
  decode(stream: OnlineStreamLike): void
  getResult(stream: OnlineStreamLike): { text?: string }
}

type OnlineStreamLike = {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}

type StreamSession = {
  stream: OnlineStreamLike
  lastTranscript: string
}

export class WhisperService {
  private readonly rootDir: string
  private readonly modelRootDir: string
  private readonly runtimeModelRootDir: string
  private readonly logger: FridayLogger
  private recognizer: OnlineRecognizerLike | null = null
  private sherpaModule: SherpaOnnxModule | null = null
  private preferredModelDir: string | null = null
  private readonly sessions = new Map<string, StreamSession>()

  constructor(userDataPath: string, logger: FridayLogger) {
    this.logger = logger
    this.rootDir = path.join(userDataPath, 'sherpa-onnx')
    this.modelRootDir = path.join(this.rootDir, 'models')
    this.runtimeModelRootDir = path.join(os.tmpdir(), 'friday-runtime', 'sherpa-model')
  }

  async getDiagnostics(): Promise<DiagnosticItem> {
    const modelReady = await exists(this.getResolvedModelFilePath('encoder.int8.onnx'))

    return {
      label: 'Voice',
      status: modelReady ? 'ready' : 'warning',
      detail: modelReady
        ? 'Локальный потоковый speech-to-text движок готов к live-расшифровке.'
        : 'Streaming speech-to-text модель будет загружена при первом голосовом запуске.',
      path: this.getModelDir(),
    }
  }

  async startSession(): Promise<{ sessionId: string }> {
    const recognizer = await this.ensureReady()
    const sessionId = crypto.randomUUID()
    this.sessions.set(sessionId, {
      stream: recognizer.createStream(),
      lastTranscript: '',
    })

    return { sessionId }
  }

  async pushAudio(sessionId: string, samplesInput: Float32Array, sampleRate: number): Promise<{ transcript: string }> {
    const recognizer = await this.ensureReady()
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Голосовая сессия не найдена.')
    }

    const samples = samplesInput instanceof Float32Array ? samplesInput : new Float32Array(samplesInput)
    session.stream.acceptWaveform({
      samples,
      sampleRate,
    })

    while (recognizer.isReady(session.stream)) {
      recognizer.decode(session.stream)
    }

    const transcript = normalizeTranscript(recognizer.getResult(session.stream).text)
    session.lastTranscript = transcript
    return { transcript }
  }

  async finishSession(sessionId: string): Promise<{ transcript: string }> {
    const recognizer = await this.ensureReady()
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Голосовая сессия не найдена.')
    }

    session.stream.inputFinished()
    while (recognizer.isReady(session.stream)) {
      recognizer.decode(session.stream)
    }

    const transcript = normalizeTranscript(recognizer.getResult(session.stream).text) || session.lastTranscript
    this.sessions.delete(sessionId)
    return { transcript }
  }

  cancelSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    this.sessions.clear()
  }

  private async ensureReady(): Promise<OnlineRecognizerLike> {
    await mkdir(this.modelRootDir, { recursive: true })

    const modelDir = await this.resolveModelDir()
    this.preferredModelDir = modelDir
    const encoderPath = path.join(modelDir, 'encoder.int8.onnx')
    if (!(await exists(encoderPath))) {
      await this.downloadAndExtractModel()
      this.preferredModelDir = await this.materializeModelDir(this.getModelDir())
    }

    if (!this.recognizer) {
      const sherpa = this.getSherpaModule()
      try {
        this.recognizer = new sherpa.OnlineRecognizer(this.buildRecognizerConfig())
      } catch (error) {
        await this.logger.error(`Failed to initialize streaming ASR recognizer: ${formatError(error)}`)
        const recoveredModelDir = await this.tryRecoverModelDir()
        if (!recoveredModelDir) {
          throw error
        }

        this.preferredModelDir = recoveredModelDir
        this.recognizer = new sherpa.OnlineRecognizer(this.buildRecognizerConfig())
      }
    }

    return this.recognizer
  }

  private getSherpaModule(): SherpaOnnxModule {
    if (!this.sherpaModule) {
      this.sherpaModule = require('sherpa-onnx-node') as SherpaOnnxModule
    }

    return this.sherpaModule
  }

  private buildRecognizerConfig(): OnlineRecognizerConfig {
    const modelDir = this.getResolvedModelDir()
    return {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: path.join(modelDir, 'encoder.int8.onnx'),
          decoder: path.join(modelDir, 'decoder.onnx'),
          joiner: path.join(modelDir, 'joiner.int8.onnx'),
        },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        modelingUnit: 'bpe',
        bpeVocab: path.join(modelDir, 'bpe.model'),
      },
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
      enableEndpoint: 0,
    }
  }

  private async downloadAndExtractModel(): Promise<void> {
    const archivePath = path.join(this.rootDir, MODEL_ARCHIVE_NAME)
    await this.logger.info(`Downloading streaming ASR model ${MODEL_ARCHIVE_NAME}`)
    await downloadFile(MODEL_URL, archivePath)

    await rm(this.getModelDir(), { recursive: true, force: true })
    await mkdir(this.modelRootDir, { recursive: true })
    await execFileAsync('tar.exe', ['-xjf', archivePath, '-C', this.modelRootDir], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    })
  }

  private getModelDir(): string {
    return path.join(this.modelRootDir, MODEL_DIR_NAME)
  }

  private getResolvedModelDir(): string {
    return this.preferredModelDir ?? this.resolveBundledModelDir() ?? this.getModelDir()
  }

  private getResolvedModelFilePath(name: string): string {
    return path.join(this.getResolvedModelDir(), name)
  }

  private async resolveModelDir(): Promise<string> {
    if (this.preferredModelDir && (await exists(path.join(this.preferredModelDir, 'encoder.int8.onnx')))) {
      return this.preferredModelDir
    }

    const bundled = this.resolveBundledModelDir()
    if (bundled && (await exists(path.join(bundled, 'encoder.int8.onnx')))) {
      return this.materializeModelDir(bundled)
    }

    return this.getModelDir()
  }

  private resolveBundledModelDir(): string | null {
    const candidateRoots = [
      path.join(process.cwd(), 'vendor', 'sherpa-model'),
      path.join(process.resourcesPath, 'sherpa-model'),
    ]

    for (const root of candidateRoots) {
      const candidate = path.join(root, MODEL_DIR_NAME)
      if (existsSync(path.join(candidate, 'encoder.int8.onnx'))) {
        return candidate
      }
    }

    return null
  }

  private async tryRecoverModelDir(): Promise<string | null> {
    const bundledModelDir = this.resolveBundledModelDir()
    if (!bundledModelDir) {
      return null
    }

    return this.materializeModelDir(bundledModelDir)
  }

  private async materializeModelDir(sourceDir: string): Promise<string> {
    const targetDir = path.join(this.runtimeModelRootDir, MODEL_DIR_NAME)
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(this.runtimeModelRootDir, { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true, force: true })
    await this.logger.info(`Materialized ASR model to ${targetDir}`)
    return targetDir
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}`)
  }

  await mkdir(path.dirname(destination), { recursive: true })
  const fileStream = createWriteStream(destination)
  await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream), fileStream)
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeTranscript(value: string | undefined): string {
  return (value ?? '').trim()
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message
  }

  return String(error)
}
