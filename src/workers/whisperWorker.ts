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
  AutoProcessor: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<
      (audio: Float32Array) => Promise<Record<string, unknown>>
    >
  }
  AutoModel: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<
      (inputs: Record<string, unknown>) => Promise<{ embeddings?: { data: Float32Array } }>
    >
  }
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
  /**
   * 'base' (default for full transcriptions) roughly halves the word error
   * rate vs 'tiny'; 'tiny' stays for live fallback chunks where latency wins.
   */
  model?: 'tiny' | 'base'
}

interface ChunkResult {
  text: string
  timestamp: [number, number | null]
}

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>

const MODEL_IDS = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
} as const

const progressCallback = (p: { status?: string; progress?: number }) => {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    post({ type: 'progress', progress: Math.round(p.progress) })
  }
}

// Pipelines are cached per model so a long-lived worker loads each once.
// WebGPU is tried first (order-of-magnitude faster where available) and the
// worker silently falls back to WASM if it fails to init OR to run.
const transcriberCache = new Map<string, Promise<Transcriber>>()
const usedWebGpu = new Set<string>()

function getTranscriber(model: 'tiny' | 'base'): Promise<Transcriber> {
  let cached = transcriberCache.get(model)
  if (!cached) {
    cached = (async () => {
      const { pipeline } = await loadTransformers()
      const hasWebGpu = 'gpu' in navigator
      if (hasWebGpu) {
        try {
          const t = await pipeline('automatic-speech-recognition', MODEL_IDS[model], {
            device: 'webgpu',
            dtype: 'q8',
            progress_callback: progressCallback,
          })
          usedWebGpu.add(model)
          return t
        } catch {
          /* fall through to WASM */
        }
      }
      return pipeline('automatic-speech-recognition', MODEL_IDS[model], {
        dtype: 'q8',
        progress_callback: progressCallback,
      })
    })()
    transcriberCache.set(model, cached)
  }
  return cached
}

/** Run inference; if a WebGPU pipeline dies mid-run, rebuild on WASM once. */
async function transcribeWith(
  model: 'tiny' | 'base',
  audio: Float32Array,
  options?: Record<string, unknown>,
): Promise<unknown> {
  try {
    const transcriber = await getTranscriber(model)
    return await transcriber(audio, options)
  } catch (error) {
    if (!usedWebGpu.has(model)) throw error
    usedWebGpu.delete(model)
    transcriberCache.delete(model)
    const { pipeline } = await loadTransformers()
    const wasm = pipeline('automatic-speech-recognition', MODEL_IDS[model], {
      dtype: 'q8',
      progress_callback: progressCallback,
    }) as Promise<Transcriber>
    transcriberCache.set(model, wasm)
    return (await wasm)(audio, options)
  }
}

interface EmbedRequest {
  type: 'embed'
  /** Mono PCM at 16 kHz. */
  audio: Float32Array
  /** Regions (seconds) to fingerprint, tagged with caller-side indexes. */
  regions: Array<{ index: number; start: number; end: number }>
}

/**
 * Speaker-verification x-vector model (WavLM): maps a stretch of speech to a
 * 512-d voice fingerprint. Far more discriminative between speakers than any
 * pitch/timbre heuristic. ~25 MB quantized, cached after first load.
 */
let embedderPromise: Promise<{
  processor: (audio: Float32Array) => Promise<Record<string, unknown>>
  model: (inputs: Record<string, unknown>) => Promise<{ embeddings?: { data: Float32Array } }>
}> | null = null

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { AutoProcessor, AutoModel } = await loadTransformers()
      const modelId = 'Xenova/wavlm-base-plus-sv'
      const processor = await AutoProcessor.from_pretrained(modelId)
      const model = await AutoModel.from_pretrained(modelId, {
        dtype: 'q8',
        progress_callback: (p: { status?: string; progress?: number }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            post({ type: 'progress', progress: Math.round(p.progress) })
          }
        },
      })
      return { processor, model }
    })()
  }
  return embedderPromise
}

async function handleEmbed(request: EmbedRequest): Promise<void> {
  try {
    post({ type: 'status', message: 'Fingerprinting voices…' })
    const { processor, model } = await getEmbedder()
    const vectors: Array<{ index: number; vector: number[] }> = []
    for (const region of request.regions) {
      const start = Math.max(0, Math.floor(region.start * 16000))
      const end = Math.min(request.audio.length, Math.ceil(region.end * 16000))
      if (end - start < 16000 * 0.8) continue
      const inputs = await processor(request.audio.slice(start, end))
      const output = await model(inputs)
      const data = output.embeddings?.data
      if (data) vectors.push({ index: region.index, vector: Array.from(data) })
    }
    post({ type: 'embeddings', vectors })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

self.onmessage = async (event: MessageEvent<TranscribeRequest | EmbedRequest>) => {
  if (event.data.type === 'embed') {
    await handleEmbed(event.data)
    return
  }
  if (event.data.type !== 'transcribe') return
  try {
    post({ type: 'status', message: 'Loading speech model…' })
    const model = event.data.model ?? (event.data.quick ? 'tiny' : 'base')

    if (event.data.quick) {
      const output = (await transcribeWith(model, event.data.audio)) as { text: string }
      post({ type: 'result', chunks: [{ text: output.text, timestamp: [0, null] }], granularity: 'chunk' })
      return
    }

    post({ type: 'status', message: 'Transcribing…' })
    // Word-level timestamps enable mid-sentence speaker changes downstream;
    // fall back to sentence chunks if the runtime rejects word granularity.
    let output: { text: string; chunks?: ChunkResult[] }
    let granularity: 'word' | 'chunk' = 'word'
    try {
      output = (await transcribeWith(model, event.data.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: 'word',
      })) as typeof output
    } catch {
      granularity = 'chunk'
      output = (await transcribeWith(model, event.data.audio, {
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
