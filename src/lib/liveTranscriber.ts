import { GreedyCaption } from './greedyCaptions'
import { MicFeatureCapture } from './micFeatures'
import { SpeakerTagger } from './speakerTagger'
import { useVoxlyStore } from '../store'
import type { TranscriptSegment } from '../types'

/**
 * Live talk-to-text with two independent engines, so words keep appearing no
 * matter what the platform does:
 *
 * 1. PRIMARY — the Web Speech API. The browser's native speech service:
 *    instant interim words, cheap on battery. But it is cloud-backed and can
 *    stall, get throttled, or not exist at all (Firefox, iOS).
 * 2. FALLBACK — on-device Whisper over rolling ~10 s PCM chunks tapped from
 *    the mic graph. Engages automatically whenever the primary goes quiet
 *    while voice is clearly present, is blocked, or is unsupported; stands
 *    down the moment the primary recovers. Higher latency (one chunk), but
 *    it cannot be taken away by the browser.
 *
 * In parallel, a low-duty-cycle mic analyser collects pitch/tone frames;
 * when a phrase is finalized we classify those frames to tag the speaker.
 * On stop, the full session recording is re-transcribed anyway (auto-refine),
 * so the final transcript never depends on either live engine.
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
/** Voice present but no recognizer events for this long → fallback captions. */
const FALLBACK_AFTER_MS = 12000
/** Fallback chunk length; also the fallback caption latency. */
const FALLBACK_CHUNK_SECONDS = 6

export class LiveTranscriber {
  private recognition: SpeechRecognitionLike | null = null
  private mic = new MicFeatureCapture()
  private tagger = new SpeakerTagger()
  private greedy = new GreedyCaption()
  private running = false
  private segmentCounter = 0
  private currentSegmentStart = 0
  private lastSpeakerId = -1
  private lastActivityAt = 0
  private lastVoiceAt = 0
  private watchdog: number | null = null
  private restartAttempts = 0
  /** Consecutive hard blocks from the speech service; drives retry cooldown. */
  private recogFailures = 0
  private cooldownUntil = 0
  private fallbackWorker: Worker | null = null
  private fallbackActive = false
  private fallbackBusy = false
  private fallbackNoticeShown = false
  private recorder: MediaRecorder | null = null
  private recordedChunks: Blob[] = []
  private wakeLock: { release: () => Promise<void> } | null = null

  get micLevel(): number {
    return this.mic.level
  }

  /** Current adaptive mic boost, for display. */
  get micBoost(): number {
    return this.mic.boost
  }

  /** Which live-caption engine is currently producing text, for display. */
  get captionEngine(): 'browser' | 'on-device' {
    return this.fallbackActive ? 'on-device' : 'browser'
  }

  /** True when transcribing device/tab audio rather than the microphone. */
  private systemAudio = false

  /**
   * @param externalStream transcribe this stream (tab/system audio) instead
   * of the microphone. The browser recognizer can only hear the mic, so
   * these sessions caption entirely with the on-device engine.
   */
  async start(lang: string, externalStream?: MediaStream): Promise<void> {
    const Ctor = getSpeechRecognition()
    this.systemAudio = Boolean(externalStream)

    await this.mic.start(externalStream)
    this.mic.onTrackEnded = () => this.handleMicRevoked()
    this.tagger.reset()
    this.greedy.reset()
    this.running = true
    this.restartAttempts = 0
    this.recogFailures = 0
    this.cooldownUntil = 0
    this.fallbackNoticeShown = false
    this.lastVoiceAt = performance.now()
    this.currentSegmentStart = 0
    this.startRecorder()
    // Keep the screen (and therefore the mic + recognizer) alive during the
    // session — phones suspending the page mid-meeting was a top cause of
    // recordings stopping "randomly". Released on stop.
    void this.acquireWakeLock()
    document.addEventListener('visibilitychange', this.onVisibility)

    if (!Ctor || this.systemAudio) {
      // No Web Speech API (Firefox, iOS, …) or capturing device audio (the
      // recognizer can only hear the mic): caption entirely on-device.
      this.activateFallback()
      return
    }

    const recognition = new Ctor()
    recognition.lang = lang
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      this.lastActivityAt = performance.now()
      this.restartAttempts = 0
      this.recogFailures = 0
      this.cooldownUntil = 0
      // The primary engine is alive again — stand the fallback down.
      this.deactivateFallback()
      this.handleResult(event)
    }
    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine; the rest are worth surfacing.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // The browser blocked the speech service (often after too many
        // programmatic restarts). Cool down with growing intervals — never
        // give up permanently — and caption on-device meanwhile.
        this.recogFailures++
        this.cooldownUntil =
          performance.now() + Math.min(5000 * 2 ** (this.recogFailures - 1), 30000)
        this.activateFallback()
      } else if (event.error === 'network') {
        this.activateFallback()
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        useVoxlyStore.getState().setError(`Speech recognition error: ${event.error}`)
      }
    }
    recognition.onend = () => {
      // Chrome ends recognition after silence gaps or errors. Words that were
      // only interim at that moment would be silently dropped — promote them
      // into the transcript before restarting. Restarts back off
      // exponentially (and respect the block cooldown) so a misbehaving
      // recognizer isn't hammered into Chrome's throttling.
      if (!this.running) return
      this.promoteInterim()
      const backoff = Math.min(50 * 2 ** this.restartAttempts, 3000)
      const cooldownWait = Math.max(0, this.cooldownUntil - performance.now())
      this.restartAttempts++
      window.setTimeout(() => {
        if (!this.running) return
        try {
          recognition.start()
        } catch {
          /* already started */
        }
      }, Math.max(backoff, cooldownWait))
    }

    this.recognition = recognition
    this.lastActivityAt = performance.now()
    recognition.start()

    // Chrome's recognizer sometimes stalls without firing onend — no results,
    // no error, just silence. Kick it ONLY when the mic hears voice while the
    // recognizer stays mute; restarting during genuine silence trips Chrome's
    // restart throttling. If the mute stretch grows past FALLBACK_AFTER_MS,
    // bring in the on-device engine so words keep appearing regardless.
    this.watchdog = window.setInterval(() => {
      if (!this.running) return
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
      if (!this.fallbackActive && voiceIsRecent && now - this.lastCaptionAt() > FALLBACK_AFTER_MS) {
        this.activateFallback()
      }
    }, WATCHDOG_INTERVAL_MS)
    this.sessionStartAt = performance.now()
  }

  private sessionStartAt = 0

  /** Most recent moment the primary engine produced anything. */
  private lastCaptionAt(): number {
    return Math.max(this.lastActivityAt, this.sessionStartAt)
  }

  // ─── On-device fallback captions ─────────────────────────────────────

  /**
   * Rolling-chunk Whisper captions from the mic's PCM tap. Only runs while
   * the primary engine is failing, so its battery cost applies exactly when
   * it is worth paying.
   */
  private activateFallback(): void {
    if (!this.running || this.fallbackActive) return
    this.fallbackActive = true
    // Expected mode for device-audio sessions — no alarm needed.
    if (!this.fallbackNoticeShown && !this.systemAudio) {
      this.fallbackNoticeShown = true
      useVoxlyStore
        .getState()
        .setError(
          'Browser captions went quiet — switched to on-device captions (words appear every ~6 s). The recording is unaffected.',
        )
    }
    if (!this.fallbackWorker) {
      this.fallbackWorker = new Worker(new URL('../workers/whisperWorker.ts', import.meta.url), {
        type: 'module',
      })
      this.fallbackWorker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; chunks?: Array<{ text: string }> }
        if (msg.type === 'result') {
          this.fallbackBusy = false
          const text = (msg.chunks ?? []).map((c) => c.text).join(' ').trim()
          // Drop results that land after the primary engine recovered.
          if (this.running && this.fallbackActive && text) this.finalizeUtterance(text)
        } else if (msg.type === 'error') {
          this.fallbackBusy = false
        }
      }
    }
    this.mic.startPcmTap((pcm, sampleRate) => this.onFallbackChunk(pcm, sampleRate), FALLBACK_CHUNK_SECONDS)
  }

  private deactivateFallback(): void {
    if (!this.fallbackActive) return
    this.fallbackActive = false
    this.mic.stopPcmTap()
    // Keep the worker (model stays warm) in case the primary fails again.
  }

  private onFallbackChunk(pcm: Float32Array, sampleRate: number): void {
    if (!this.running || !this.fallbackActive || !this.fallbackWorker) return
    if (this.fallbackBusy) return // device slower than realtime — skip a chunk
    // Skip silent chunks entirely.
    let sumSquares = 0
    for (let i = 0; i < pcm.length; i += 4) sumSquares += pcm[i] * pcm[i]
    if (Math.sqrt(sumSquares / (pcm.length / 4)) < 0.004) return

    const audio = downsampleTo16k(pcm, sampleRate)
    this.fallbackBusy = true
    this.fallbackWorker.postMessage({ type: 'transcribe', audio, quick: true }, [audio.buffer])
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const store = useVoxlyStore.getState()
    let interimText = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue

      if (result.isFinal) {
        // Greedy capture: if the recognizer's "corrected" final dropped words
        // that were already on screen, keep the words we captured. Refine
        // fixes real errors after the session.
        this.finalizeUtterance(this.greedy.finalize(text))
      } else {
        interimText += `${text} `
      }
    }

    if (interimText.trim()) {
      // Words older than the live edge are locked — later revisions can
      // extend this text but never rewrite or retract it mid-phrase.
      const display = this.greedy.update(interimText)
      store.upsertSegment({
        id: 'live-interim',
        speakerId: this.lastSpeakerId,
        text: display,
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
    this.greedy.reset()
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
      // 128 kbps Opus: the browser default (~32-48 kbps) audibly degrades
      // consonants, which is exactly what Whisper needs to hear.
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(stream, { audioBitsPerSecond: 128000 })
      } catch {
        recorder = new MediaRecorder(stream)
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.recordedChunks.push(event.data)
      }
      // Finalize on ANY stop — including the recorder dying because the OS
      // revoked the mic — so captured audio is never lost.
      recorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' })
        this.recordedChunks = []
        if (blob.size > 0) useVoxlyStore.getState().setRecordingBlob(blob)
      }
      recorder.start(10000) // flush a chunk every 10 s
      this.recorder = recorder
    } catch {
      this.recorder = null
    }
  }

  private stopRecorder(): void {
    const recorder = this.recorder
    this.recorder = null
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
  }

  private async acquireWakeLock(): Promise<void> {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    if (!nav.wakeLock) return
    try {
      this.wakeLock = await nav.wakeLock.request('screen')
    } catch {
      // Denied (low battery mode, etc.) — recording still works while the
      // page stays in the foreground.
    }
  }

  private onVisibility = () => {
    // Wake locks auto-release when the page is hidden; re-arm on return.
    if (!document.hidden && this.running) void this.acquireWakeLock()
  }

  /** The audio source ended (mic revoked, or the user stopped sharing). */
  private handleMicRevoked(): void {
    if (!this.running) return
    const wasSystemAudio = this.systemAudio
    this.stop()
    const store = useVoxlyStore.getState()
    store.setMode('idle')
    if (wasSystemAudio) {
      // Ending the share is the natural way to finish these sessions —
      // auto-refine picks the recording up from here.
      return
    }
    store.setError(
      'The system took the microphone (a call or another app). Recording stopped — everything captured so far is kept and can be transcribed with Refine transcript.',
    )
  }

  stop(): void {
    this.running = false
    document.removeEventListener('visibilitychange', this.onVisibility)
    void this.wakeLock?.release().catch(() => {})
    this.wakeLock = null
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.deactivateFallback()
    this.fallbackWorker?.terminate()
    this.fallbackWorker = null
    this.fallbackBusy = false
    this.recognition?.stop()
    this.recognition = null
    // Whatever was being said when the user hit stop belongs in the
    // transcript, not the bin.
    this.promoteInterim()
    this.stopRecorder()
    this.mic.onTrackEnded = null
    this.mic.stop()
    this.removeInterim()
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Nearest-sample decimation to Whisper's 16 kHz — plenty for ASR. */
function downsampleTo16k(pcm: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return pcm.slice()
  const ratio = fromRate / 16000
  const out = new Float32Array(Math.floor(pcm.length / ratio))
  for (let i = 0; i < out.length; i++) {
    out[i] = pcm[Math.floor(i * ratio)]
  }
  return out
}
