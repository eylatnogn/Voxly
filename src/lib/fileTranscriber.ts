import {
  buildVoicedRegions,
  chunksToSegments,
  wordsToSegments,
  type TimedWord,
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

  const result = await runWhisper(pcm)
  if (!result) return // error already surfaced

  useVoxlyStore.getState().setFileProgress(null, 'Identifying speakers…')

  // Voice features over the whole recording, grouped into voiced regions and
  // clustered into speakers.
  const frames = extractFrames(pcm, WHISPER_SAMPLE_RATE, 0, duration)
  const tagger = new SpeakerTagger()
  const regions = buildVoicedRegions(frames, tagger)
  for (const region of regions) {
    if (region.speakerId >= 0 && region.medianPitchHz > 0) {
      useVoxlyStore.getState().ensureSpeaker(region.speakerId, region.medianPitchHz)
    }
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

function runWhisper(pcm: Float32Array): Promise<WhisperResult | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/whisperWorker.ts', import.meta.url), {
      type: 'module',
    })
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
          worker.terminate()
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
