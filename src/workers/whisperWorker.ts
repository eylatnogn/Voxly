/**
 * Whisper transcription in a dedicated worker.
 *
 * Loaded lazily — this file (and the transformers.js runtime + model weights)
 * only ever downloads when the user actually transcribes a file, so the main
 * app stays light and live mode costs nothing extra. The worker is terminated
 * by the client after each job to release the model memory.
 *
 * whisper-tiny.en quantized is used deliberately: smallest available model
 * (~40 MB), fastest inference, lowest energy per transcribed minute.
 *
 * The transformers.js runtime is imported from the CDN at run time rather
 * than bundled: it keeps `npm install` free of native onnxruntime build
 * steps and the app bundle small. The import only happens inside this
 * worker, on first use.
 */

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1'

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<(audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>>
  env: { allowLocalModels: boolean }
}

async function loadTransformers(): Promise<TransformersModule> {
  const mod = (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as unknown as TransformersModule
  mod.env.allowLocalModels = false
  return mod
}

interface TranscribeRequest {
  type: 'transcribe'
  /** Mono PCM at 16 kHz. */
  audio: Float32Array
}

interface ChunkResult {
  text: string
  timestamp: [number, number | null]
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  if (event.data.type !== 'transcribe') return
  try {
    post({ type: 'status', message: 'Loading speech model…' })
    const { pipeline } = await loadTransformers()
    const transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      {
        dtype: 'q8',
        progress_callback: (p: { status?: string; progress?: number }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            post({ type: 'progress', progress: Math.round(p.progress) })
          }
        },
      },
    )

    post({ type: 'status', message: 'Transcribing…' })
    const output = (await transcriber(event.data.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    })) as { text: string; chunks?: ChunkResult[] }

    const chunks: ChunkResult[] =
      output.chunks && output.chunks.length > 0
        ? output.chunks
        : [{ text: output.text, timestamp: [0, null] }]

    post({ type: 'result', chunks })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function post(message: unknown): void {
  ;(self as unknown as Worker).postMessage(message)
}
