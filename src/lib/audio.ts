import type { DiagnosticItem } from '@shared/contracts'

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096

export interface VoiceRecorder {
  start(onChunk: (samples: Float32Array, sampleRate: number) => void): Promise<void>
  stop(): Promise<void>
  dispose(): void
}

export class PushToTalkRecorder implements VoiceRecorder {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processorNode: ScriptProcessorNode | null = null
  private sinkGainNode: GainNode | null = null

  async start(onChunk: (samples: Float32Array, sampleRate: number) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API is not available in this browser context.')
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })

    this.audioContext = new AudioContext({
      latencyHint: 'interactive',
    })
    await this.audioContext.resume()

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
    this.processorNode = this.audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1)
    this.sinkGainNode = this.audioContext.createGain()
    this.sinkGainNode.gain.value = 0

    this.processorNode.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0)
      if (!samples.length) {
        return
      }

      onChunk(new Float32Array(samples), event.inputBuffer.sampleRate)
    }

    this.sourceNode.connect(this.processorNode)
    this.processorNode.connect(this.sinkGainNode)
    this.sinkGainNode.connect(this.audioContext.destination)
  }

  async stop(): Promise<void> {
    await this.teardown()
  }

  dispose(): void {
    void this.teardown()
  }

  private async teardown(): Promise<void> {
    this.processorNode?.disconnect()
    this.sourceNode?.disconnect()
    this.sinkGainNode?.disconnect()

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
    }

    if (this.audioContext) {
      await this.audioContext.close()
    }

    this.processorNode = null
    this.sourceNode = null
    this.sinkGainNode = null
    this.audioContext = null
    this.stream = null
  }
}

export async function checkMicrophoneSupport(): Promise<DiagnosticItem> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      label: 'Микрофон',
      status: 'error',
      detail: 'Захват звука недоступен в этом окружении.',
    }
  }

  try {
    if ('permissions' in navigator && navigator.permissions?.query) {
      const permission = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })

      if (permission.state === 'denied') {
        return {
          label: 'Микрофон',
          status: 'error',
          detail: 'Доступ к микрофону для приложения заблокирован.',
        }
      }

      if (permission.state === 'prompt') {
        return {
          label: 'Микрофон',
          status: 'warning',
          detail: 'Разрешение на микрофон будет запрошено при первом использовании.',
        }
      }
    }

    return {
      label: 'Микрофон',
      status: 'ready',
      detail: 'Микрофон доступен для потоковой записи и live-расшифровки.',
    }
  } catch {
    return {
      label: 'Микрофон',
      status: 'warning',
      detail: 'Не удалось определить текущее состояние разрешения.',
    }
  }
}
