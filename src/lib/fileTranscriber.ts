import { analyzeFrame, type VoiceFrame } from './pitch'
import { SpeakerTagger } from './speakerTagger'
import { useVoxlyStore } from '../store'
import type { TranscriptSegment } from '../types'

/**
 * Audio-file transcription: decode → Whisper (in a lazy worker) → speaker
 * tagging from pitch/tone over each timestamped chunk.
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

  const chunks = await runWhisper(pcm)
  if (!chunks) return // error already surfaced

  // Attribute each chunk to a speaker from its voice features.
  const tagger = new SpeakerTagger()
  const segments: TranscriptSegment[] = []
  let lastSpeakerId = -1
  chunks.forEach((chunk, index) => {
    const text = chunk.text.trim()
    if (!text) return
    const start = chunk.timestamp[0] ?? 0
    const end = chunk.timestamp[1] ?? Math.min(start + 30, duration)
    const frames = extractFrames(pcm, WHISPER_SAMPLE_RATE, start, end)
    const match = tagger.classify(frames)
    const speakerId = match ? match.speakerId : lastSpeakerId
    if (match) {
      useVoxlyStore.getState().ensureSpeaker(match.speakerId, match.medianPitchHz)
      lastSpeakerId = match.speakerId
    }
    segments.push({ id: `file-${index}`, speakerId, text, startTime: start, endTime: end })
  })

  // Merge consecutive chunks from the same speaker into readable paragraphs.
  const merged = mergeAdjacent(segments)
  useVoxlyStore.getState().replaceSegments(merged)
  useVoxlyStore.getState().setFileProgress(null, null)
  useVoxlyStore.getState().setMode('idle')
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
  return { pcm: rendered.getChannelData(0), duration: decoded.duration }
}

function runWhisper(pcm: Float32Array): Promise<ChunkResult[] | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/whisperWorker.ts', import.meta.url), {
      type: 'module',
    })
    const store = useVoxlyStore.getState()

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'status'; message: string }
        | { type: 'progress'; progress: number }
        | { type: 'result'; chunks: ChunkResult[] }
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
          resolve(msg.chunks)
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

function mergeAdjacent(segments: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last && last.speakerId === segment.speakerId && segment.startTime - last.endTime < 2) {
      last.text = `${last.text} ${segment.text}`.replace(/ {2,}/g, ' ')
      last.endTime = segment.endTime
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}
