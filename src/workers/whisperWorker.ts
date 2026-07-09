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
  /**
   * Quick mode for live fallback captions: plain transcription of a short
   * chunk, no timestamps, no chunking overhead.
   */
  quick?: boolean
}

interface ChunkResult {
  text: string
  timestamp: [number, number | null]
}

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>

// The pipeline is cached so a long-lived worker (live fallback captions)
// loads the model once and reuses it for every chunk.
let transcriberPromise: Promise<Transcriber> | null = null

function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await loadTransformers()
      return pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
        dtype: 'q8',
        progress_callback: (p: { status?: string; progress?: number }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            post({ type: 'progress', progress: Math.round(p.progress) })
          }
        },
      })
    })()
  }
  return transcriberPromise
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  if (event.data.type !== 'transcribe') return
  try {
    post({ type: 'status', message: 'Loading speech model…' })
    const transcriber = await getTranscriber()

    if (event.data.quick) {
      const output = (await transcriber(event.data.audio)) as { text: string }
      post({ type: 'result', chunks: [{ text: output.text, timestamp: [0, null] }], granularity: 'chunk' })
      return
    }

    post({ type: 'status', message: 'Transcribing…' })
    // Word-level timestamps enable mid-sentence speaker changes downstream;
    // fall back to sentence chunks if the runtime rejects word granularity.
    let output: { text: string; chunks?: ChunkResult[] }
    let granularity: 'word' | 'chunk' = 'word'
    try {
      output = (await transcriber(event.data.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: 'word',
      })) as typeof output
    } catch {
      granularity = 'chunk'
      output = (await transcriber(event.data.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      })) as typeof output
    }

    const chunks: ChunkResult[] =
      output.chunks && output.chunks.length > 0
        ? output.chunks
        : [{ text: output.text, timestamp: [0, null] }]

    // Word chunks are short tokens; if the runtime silently returned sentence
    // spans despite the word request, treat the result as chunk-level.
    if (granularity === 'word' && chunks.length > 0) {
      const avgLength = chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length
      if (avgLength > 20) granularity = 'chunk'
    }

    post({ type: 'result', chunks, granularity })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function post(message: unknown): void {
  ;(self as unknown as Worker).postMessage(message)
}
