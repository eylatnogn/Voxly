import {
  buildVoicedRegions,
  chunksToSegments,
  clusterEmbeddings,
  wordsToSegments,
  type TimedWord,
  type VoicedRegion,
} from './diarization'
import { analyzeFrame, type VoiceFrame } from './pitch'
import { SpeakerTagger } from './speakerTagger'
import { useVoxlyStore } from '../store'

/**
 * Audio-file transcription: decode → Whisper (in a lazy worker) → word-level
 * speaker diarization from pitch/tone, so speaker changes are caught even
 * mid-sentence.
 *
 * The Whisper worker is created per job and terminated afterwards so the
 * model's memory (and any background CPU) is fully released — you only pay
 * for transcription while it is actually happening.
 */

const WHISPER_SAMPLE_RATE = 16000

interface ChunkResult {
  text: string
  timestamp: [number, number | null]
}

interface WhisperResult {
  chunks: ChunkResult[]
  granularity: 'word' | 'chunk'
}

export async function transcribeFile(file: File): Promise<void> {
  const store = useVoxlyStore.getState()
  store.clearSession()
  store.setMode('file')
  store.setFileProgress(0, 'Decoding audio…')

  let pcm: Float32Array
  let duration: number
  try {
    const decoded = await decodeToMono(file)
    pcm = decoded.pcm
    duration = decoded.duration
  } catch {
    store.setMode('idle')
    store.setFileProgress(null, null)
    store.setError('Could not decode that file. Supported formats: wav, mp3, m4a, ogg, webm, flac.')
    return
  }

  const worker = new Worker(new URL('../workers/whisperWorker.ts', import.meta.url), {
    type: 'module',
  })
  const result = await runWhisper(worker, pcm)
  if (!result) return // error already surfaced (worker terminated there)

  useVoxlyStore.getState().setFileProgress(null, 'Identifying speakers…')

  // Voice features over the whole recording, grouped into voiced regions.
  // Pitch clustering provides speaker ids as the fallback…
  const frames = extractFrames(pcm, WHISPER_SAMPLE_RATE, 0, duration)
  const tagger = new SpeakerTagger()
  const regions = buildVoicedRegions(frames, tagger)

  // …and neural voice fingerprints override them when available: an x-vector
  // embedding per region, clustered by cosine similarity — far more accurate
  // between genuinely different voices than pitch alone.
  const vectors = await runEmbeddings(worker, pcm, regions)
  worker.terminate()
  if (vectors) {
    const clusterIds = clusterEmbeddings(vectors)
    let lastId = -1
    for (let i = 0; i < regions.length; i++) {
      if (clusterIds[i] >= 0) {
        regions[i].speakerId = clusterIds[i]
        lastId = clusterIds[i]
      } else {
        // Region too short to fingerprint — assume the surrounding speaker.
        regions[i].speakerId = lastId
      }
    }
  }

  // Register speakers with a representative pitch hint per cluster.
  const pitchByCluster = new Map<number, number[]>()
  for (const region of regions) {
    if (region.speakerId >= 0 && region.medianPitchHz > 0) {
      const list = pitchByCluster.get(region.speakerId) ?? []
      list.push(region.medianPitchHz)
      pitchByCluster.set(region.speakerId, list)
    }
  }
  for (const [speakerId, pitches] of pitchByCluster) {
    const sorted = pitches.slice().sort((a, b) => a - b)
    useVoxlyStore.getState().ensureSpeaker(speakerId, sorted[Math.floor(sorted.length / 2)])
  }

  const timed = result.chunks
    .map((chunk) => ({
      text: chunk.text,
      start: chunk.timestamp[0] ?? 0,
      end: chunk.timestamp[1] ?? Math.min((chunk.timestamp[0] ?? 0) + 30, duration),
    }))
    .filter((c): c is TimedWord => c.text.trim().length > 0)

  const segments =
    result.granularity === 'word'
      ? wordsToSegments(timed, regions)
      : chunksToSegments(timed, regions)

  useVoxlyStore.getState().replaceSegments(segments)
  useVoxlyStore.getState().setFileProgress(null, null)
  useVoxlyStore.getState().setMode('idle')
  // Keep the audio around for playback — unless this was a refine pass, where
  // the live recording is already (re-)stored by the caller and should keep
  // its 'live' kind so Refine stays available.
  if (!useVoxlyStore.getState().recordingBlob) {
    useVoxlyStore.getState().setRecordingBlob(file, 'file')
  }
}

async function decodeToMono(file: File): Promise<{ pcm: Float32Array; duration: number }> {
  const arrayBuffer = await file.arrayBuffer()
  // OfflineAudioContext resamples to 16 kHz during decode — cheaper than
  // decoding at native rate and resampling in JS.
  const probe = new AudioContext()
  const decoded = await probe.decodeAudioData(arrayBuffer)
  await probe.close()

  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE),
    WHISPER_SAMPLE_RATE,
  )
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  const pcm = rendered.getChannelData(0)
  normalizeQuietAudio(pcm)
  return { pcm, duration: decoded.duration }
}

/**
 * Boost quiet recordings (e.g. speakers far from the microphone) to full
 * scale before transcription and voice analysis — both Whisper and the pitch
 * tracker perform noticeably better on well-leveled audio. Loud recordings
 * are left untouched.
 */
function normalizeQuietAudio(pcm: Float32Array): void {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const magnitude = Math.abs(pcm[i])
    if (magnitude > peak) peak = magnitude
  }
  if (peak >= 0.5 || peak <= 0) return
  const gain = Math.min(0.9 / peak, 24)
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain
}

function runWhisper(worker: Worker, pcm: Float32Array): Promise<WhisperResult | null> {
  return new Promise((resolve) => {
    const store = useVoxlyStore.getState()

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'status'; message: string }
        | { type: 'progress'; progress: number }
        | { type: 'result'; chunks: ChunkResult[]; granularity: 'word' | 'chunk' }
        | { type: 'error'; message: string }
      switch (msg.type) {
        case 'status':
          store.setFileProgress(useVoxlyStore.getState().fileProgress, msg.message)
          break
        case 'progress':
          store.setFileProgress(msg.progress)
          break
        case 'result':
          resolve({ chunks: msg.chunks, granularity: msg.granularity })
          break
        case 'error':
          worker.terminate()
          store.setMode('idle')
          store.setFileProgress(null, null)
          store.setError(`Transcription failed: ${msg.message}`)
          resolve(null)
          break
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      store.setMode('idle')
      store.setFileProgress(null, null)
      store.setError(`Transcription worker failed: ${event.message}`)
      resolve(null)
    }

    // Transfer a copy: the original array is still needed on this side for
    // speaker-feature extraction after transcription completes.
    const audio = pcm.slice()
    worker.postMessage({ type: 'transcribe', audio }, [audio.buffer])
  })
}

/**
 * Fingerprint the voiced regions with the speaker-verification model. Long
 * meetings are capped at the 150 longest regions (shorter ones inherit their
 * neighbor's speaker) to bound inference time. Returns null when the model
 * can't load — pitch clustering remains in effect.
 */
function runEmbeddings(
  worker: Worker,
  pcm: Float32Array,
  regions: VoicedRegion[],
): Promise<Array<number[] | null> | null> {
  const eligible = regions
    .map((region, index) => ({ index, start: region.start, end: region.end }))
    .filter((r) => r.end - r.start >= 0.8)
  if (eligible.length === 0) return Promise.resolve(null)
  const capped = eligible
    .slice()
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 150)
    .sort((a, b) => a.index - b.index)

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(null), 180000)
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'status'; message: string }
        | { type: 'progress'; progress: number }
        | { type: 'embeddings'; vectors: Array<{ index: number; vector: number[] }> }
        | { type: 'error'; message: string }
      switch (msg.type) {
        case 'progress':
          useVoxlyStore.getState().setFileProgress(msg.progress, 'Fingerprinting voices…')
          break
        case 'embeddings': {
          clearTimeout(timeout)
          const vectors: Array<number[] | null> = regions.map(() => null)
          for (const { index, vector } of msg.vectors) vectors[index] = vector
          resolve(vectors)
          break
        }
        case 'error':
          clearTimeout(timeout)
          resolve(null)
          break
        default:
          break
      }
    }
    worker.onerror = () => {
      clearTimeout(timeout)
      resolve(null)
    }
    const audio = pcm.slice()
    worker.postMessage({ type: 'embed', audio, regions: capped }, [audio.buffer])
  })
}

/** Sample voice frames across a time range at ~4 fps equivalent spacing. */
function extractFrames(
  pcm: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
): VoiceFrame[] {
  const frames: VoiceFrame[] = []
  const frameSize = 2048
  const stepSec = 0.25
  for (let t = startSec; t + frameSize / sampleRate < endSec; t += stepSec) {
    const offset = Math.floor(t * sampleRate)
    if (offset + frameSize > pcm.length) break
    const frame = analyzeFrame(pcm.subarray(offset, offset + frameSize), sampleRate, t)
    if (frame) frames.push(frame)
  }
  return frames
}
