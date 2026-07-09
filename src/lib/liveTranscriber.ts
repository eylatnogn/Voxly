import { MicFeatureCapture } from './micFeatures'
import { SpeakerTagger } from './speakerTagger'
import { useVoxlyStore } from '../store'
import type { TranscriptSegment } from '../types'

/**
 * Live talk-to-text built on the Web Speech API.
 *
 * The browser delegates recognition to the platform speech service (often
 * hardware-accelerated and shared with the OS keyboard dictation), which is
 * dramatically cheaper on battery than running a neural model in JS. In
 * parallel, a low-duty-cycle mic analyser collects pitch/tone frames; when a
 * phrase is finalized we classify those frames to tag the speaker.
 */

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

export function isLiveTranscriptionSupported(): boolean {
  return getSpeechRecognition() !== null
}

/**
 * Force a restart when the mic HEARS voice but the recognizer delivers no
 * events for this long. Plain silence must never trigger a restart — cycling
 * the recognizer during quiet stretches makes Chrome throttle or kill it,
 * which shows up as a transcript that stops writing anything at all.
 */
const STALL_TIMEOUT_MS = 8000
const WATCHDOG_INTERVAL_MS = 4000
/** Mic level above this counts as "someone is speaking". */
const VOICE_LEVEL_THRESHOLD = 0.06

export class LiveTranscriber {
  private recognition: SpeechRecognitionLike | null = null
  private mic = new MicFeatureCapture()
  private tagger = new SpeakerTagger()
  private running = false
  private segmentCounter = 0
  private currentSegmentStart = 0
  private lastSpeakerId = -1
  private lastActivityAt = 0
  private lastVoiceAt = 0
  private watchdog: number | null = null
  private restartAttempts = 0
  private recognitionDead = false
  private recorder: MediaRecorder | null = null
  private recordedChunks: Blob[] = []

  get micLevel(): number {
    return this.mic.level
  }

  /** Current adaptive mic boost, for display. */
  get micBoost(): number {
    return this.mic.boost
  }

  async start(lang: string): Promise<void> {
    const Ctor = getSpeechRecognition()
    if (!Ctor) throw new Error('This browser does not support the Web Speech API. Try Chrome or Edge, or use the audio-file mode.')

    await this.mic.start()
    this.tagger.reset()
    this.running = true
    this.recognitionDead = false
    this.restartAttempts = 0
    this.lastVoiceAt = performance.now()
    this.currentSegmentStart = 0
    this.startRecorder()

    const recognition = new Ctor()
    recognition.lang = lang
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      this.lastActivityAt = performance.now()
      this.restartAttempts = 0
      this.handleResult(event)
    }
    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine; the rest are worth surfacing.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // The browser blocked the speech service (often after too many
        // programmatic restarts). More restarts make it worse — stop trying.
        // The session recording keeps capturing, so nothing is lost.
        this.recognitionDead = true
        useVoxlyStore
          .getState()
          .setError(
            'The browser paused live captions. Your audio is still being recorded — press Stop, then "✨ Refine transcript" to transcribe everything on this device.',
          )
      } else if (event.error === 'network') {
        useVoxlyStore
          .getState()
          .setError(
            'Speech service connection hiccup — some words may have been missed. Recognition restarts automatically; the recording still captures everything for Refine.',
          )
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        useVoxlyStore.getState().setError(`Speech recognition error: ${event.error}`)
      }
    }
    recognition.onend = () => {
      // Chrome ends recognition after silence gaps or errors. Words that were
      // only interim at that moment would be silently dropped — promote them
      // into the transcript before restarting. Restarts back off
      // exponentially so a misbehaving recognizer isn't hammered into
      // Chrome's throttling.
      if (!this.running || this.recognitionDead) return
      this.promoteInterim()
      const delay = Math.min(50 * 2 ** this.restartAttempts, 3000)
      this.restartAttempts++
      window.setTimeout(() => {
        if (!this.running || this.recognitionDead) return
        try {
          recognition.start()
        } catch {
          /* already started */
        }
      }, delay)
    }

    this.recognition = recognition
    this.lastActivityAt = performance.now()
    recognition.start()

    // Chrome's recognizer sometimes stalls without firing onend — no results,
    // no error, just silence. Kick it ONLY when the mic hears voice while the
    // recognizer stays mute; restarting during genuine silence trips Chrome's
    // restart throttling and kills live captions entirely.
    this.watchdog = window.setInterval(() => {
      if (!this.running || this.recognitionDead) return
      const now = performance.now()
      if (this.mic.level > VOICE_LEVEL_THRESHOLD) this.lastVoiceAt = now
      const voiceIsRecent = now - this.lastVoiceAt < 5000
      if (voiceIsRecent && now - this.lastActivityAt > STALL_TIMEOUT_MS) {
        this.lastActivityAt = now
        try {
          this.recognition?.stop()
        } catch {
          /* not running */
        }
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const store = useVoxlyStore.getState()
    let interimText = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue

      if (result.isFinal) {
        this.finalizeUtterance(text)
      } else {
        interimText += `${text} `
      }
    }

    if (interimText.trim()) {
      store.upsertSegment({
        id: 'live-interim',
        speakerId: this.lastSpeakerId,
        text: interimText.trim(),
        startTime: this.currentSegmentStart,
        endTime: this.mic.elapsedSeconds(),
        interim: true,
      })
    }
  }

  /** Commit one utterance to the transcript with a speaker classification. */
  private finalizeUtterance(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const store = useVoxlyStore.getState()
    const frames = this.mic.drainFrames()
    const match = this.tagger.classify(frames)
    // Clusters that turned out to be the same voice get folded together —
    // retag everything already attributed to the absorbed speaker.
    for (const merge of this.tagger.drainMerges()) {
      store.remapSpeaker(merge.from, merge.to)
      if (this.lastSpeakerId === merge.from) this.lastSpeakerId = merge.to
    }
    const speakerId = match ? match.speakerId : this.lastSpeakerId
    if (match) {
      store.ensureSpeaker(match.speakerId, match.medianPitchHz)
      this.lastSpeakerId = match.speakerId
    }
    const now = this.mic.elapsedSeconds()
    const segment: TranscriptSegment = {
      id: `live-${this.segmentCounter++}`,
      speakerId,
      text: capitalize(trimmed),
      startTime: this.currentSegmentStart,
      endTime: now,
    }
    this.currentSegmentStart = now
    store.upsertSegment(segment)
    this.removeInterim()
  }

  /** Rescue words that were still interim when recognition ended. */
  private promoteInterim(): void {
    const store = useVoxlyStore.getState()
    const interim = store.segments.find((s) => s.id === 'live-interim')
    if (interim?.text.trim()) this.finalizeUtterance(interim.text)
  }

  private removeInterim(): void {
    const store = useVoxlyStore.getState()
    store.replaceSegments(store.segments.filter((s) => s.id !== 'live-interim'))
  }

  /**
   * Record the session audio alongside live recognition (the browser's
   * hardware Opus encoder makes this nearly free). After the session, the
   * recording can be re-transcribed with the on-device Whisper model — far
   * more accurate than the live recognizer, and with word-level speaker
   * tagging.
   */
  private startRecorder(): void {
    const stream = this.mic.recordingStream
    if (!stream || typeof MediaRecorder === 'undefined') return
    try {
      this.recordedChunks = []
      this.recorder = new MediaRecorder(stream)
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.recordedChunks.push(event.data)
      }
      this.recorder.start(10000) // flush a chunk every 10 s
    } catch {
      this.recorder = null
    }
  }

  private stopRecorder(): void {
    const recorder = this.recorder
    this.recorder = null
    if (!recorder || recorder.state === 'inactive') return
    recorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' })
      this.recordedChunks = []
      if (blob.size > 0) useVoxlyStore.getState().setRecordingBlob(blob)
    }
    recorder.stop()
  }

  stop(): void {
    this.running = false
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.recognition?.stop()
    this.recognition = null
    // Whatever was being said when the user hit stop belongs in the
    // transcript, not the bin.
    this.promoteInterim()
    this.stopRecorder()
    this.mic.stop()
    this.removeInterim()
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
