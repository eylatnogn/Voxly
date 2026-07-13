import { analyzeFrame, FAR_FIELD_ENERGY_GATE, type VoiceFrame } from './pitch'
import { currentDutyCycle } from './power'

/**
 * Captures the microphone and extracts voice frames (pitch + timbre) at a
 * battery-friendly duty cycle. Instead of processing every audio callback,
 * an AnalyserNode buffers the signal continuously in native code (cheap) and
 * we only pull + analyze a snapshot a few times per second from a JS timer.
 *
 * Sensitivity is fully automatic: an adaptive gain stage (1×–8×) targets a
 * steady speech level, so a voice across the room gets boosted while someone
 * next to the phone is pulled back, with a soft limiter preventing clipping.
 * The boosted signal feeds the pitch analysis, the level meter, and the
 * session recording used by the Whisper refine pass.
 *
 * IMPORTANT: capture constraints are never customized. Requesting a "raw"
 * stream (noise suppression / echo cancellation off) reconfigures the shared
 * microphone session on mobile and starves the platform speech recognizer.
 * All boosting happens in our own WebAudio graph, which cannot affect the
 * recognizer's feed.
 *
 * Frames are buffered per-utterance; the live transcriber drains them when a
 * phrase is finalized to decide who was speaking.
 */

/** Adaptive gain aims for this RMS on voiced audio. */
const TARGET_SPEECH_RMS = 0.18
const MIN_GAIN = 1
const MAX_GAIN = 10
/** Ignore post-gain energy below this when adapting (true silence). */
const ADAPT_FLOOR = 0.001
/** Max multiplicative gain change per analysis frame — smooth, no pumping. */
const ADAPT_STEP = 0.15

export class MicFeatureCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private boostedOut: MediaStreamAudioDestinationNode | null = null
  private timer: number | null = null
  private tapNode: ScriptProcessorNode | null = null
  private tapSink: GainNode | null = null
  private frames: VoiceFrame[] = []
  private startedAt = 0
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(2048)

  /** Latest RMS level (0..1) for the UI meter. */
  level = 0

  /** Fired when the OS revokes the microphone (call, another app, etc.). */
  onTrackEnded: (() => void) | null = null

  /** Current adaptive boost factor, for display. */
  get boost(): number {
    return this.gainNode?.gain.value ?? 1
  }

  /** Amplified stream for the session recorder. */
  get recordingStream(): MediaStream | null {
    return this.boostedOut?.stream ?? this.stream
  }

  /**
   * @param externalStream capture this stream (e.g. tab/system audio from
   * getDisplayMedia) instead of opening the microphone. The rest of the
   * pipeline — adaptive gain, analysis, recording — is identical.
   */
  async start(externalStream?: MediaStream): Promise<void> {
    this.stream =
      externalStream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }))
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', this.handleTrackEnded)
    }
    this.context = new AudioContext()
    // Mobile browsers can move the context to 'suspended'/'interrupted'
    // (screen events, audio focus changes). Resume it — the session
    // recording depends on this graph staying alive.
    this.context.onstatechange = () => {
      if (this.context && this.context.state === 'suspended') {
        void this.context.resume()
      }
    }
    const source = this.context.createMediaStreamSource(this.stream)
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 2048

    this.gainNode = this.context.createGain()
    this.gainNode.gain.value = MIN_GAIN
    const limiter = this.context.createDynamicsCompressor()
    limiter.threshold.value = -12
    limiter.knee.value = 10
    limiter.ratio.value = 8
    limiter.attack.value = 0.004
    limiter.release.value = 0.2
    this.boostedOut = this.context.createMediaStreamDestination()
    source.connect(this.gainNode)
    this.gainNode.connect(limiter)
    limiter.connect(this.analyser)
    limiter.connect(this.boostedOut)

    this.startedAt = performance.now()
    this.scheduleNext()

    // Tab hidden = user is not looking; suspend the audio graph and timers
    // entirely. SpeechRecognition keeps transcribing independently.
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  private handleTrackEnded = () => {
    this.onTrackEnded?.()
  }

  private onVisibility = () => {
    if (!this.context) return
    // The audio graph must NOT be suspended while hidden — the session
    // recording flows through it, and suspending silently killed recordings
    // whenever the tab was backgrounded or the screen locked. Instead the
    // analysis duty cycle drops to a 1 fps trickle (scheduleNext reads
    // document.hidden), which keeps battery cost negligible.
    if (!document.hidden) {
      void this.context.resume()
      if (this.timer === null) this.scheduleNext()
    }
  }

  private scheduleNext(): void {
    const fps = document.hidden ? 1 : currentDutyCycle().analysisFps
    this.timer = window.setTimeout(() => {
      this.captureFrame()
      if (this.context) this.scheduleNext()
    }, 1000 / fps)
  }

  private captureFrame(): void {
    if (!this.analyser || !this.context) return
    this.analyser.getFloatTimeDomainData(this.buffer)

    // Adapt gain from the post-gain energy: quiet speech ramps the boost up,
    // loud speech brings it back down. Silence leaves it untouched.
    let sumSquares = 0
    for (let i = 0; i < this.buffer.length; i++) {
      sumSquares += this.buffer[i] * this.buffer[i]
    }
    const energy = Math.sqrt(sumSquares / this.buffer.length)
    if (energy > ADAPT_FLOOR && this.gainNode) {
      const ratio = TARGET_SPEECH_RMS / energy
      const step = Math.min(Math.max(ratio, 1 - ADAPT_STEP), 1 + ADAPT_STEP)
      this.gainNode.gain.value = Math.min(MAX_GAIN, Math.max(MIN_GAIN, this.gainNode.gain.value * step))
    }

    const time = (performance.now() - this.startedAt) / 1000
    const frame = analyzeFrame(this.buffer, this.context.sampleRate, time, FAR_FIELD_ENERGY_GATE)
    this.level = frame ? Math.min(1, frame.energy * 5) : 0
    if (frame) {
      this.frames.push(frame)
      // Bound memory if no utterance boundary arrives for a long time.
      if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 600)
    }
  }

  /**
   * Tap the amplified audio as raw PCM chunks (~chunkSeconds each) — used by
   * the on-device fallback captions when the browser recognizer goes quiet.
   * Costs one buffer copy per 85 ms while active; detached when not needed.
   */
  startPcmTap(
    onChunk: (pcm: Float32Array, sampleRate: number) => void,
    chunkSeconds = 10,
  ): void {
    if (!this.context || !this.analyser || this.tapNode) return
    const proc = this.context.createScriptProcessor(4096, 1, 1)
    const targetSamples = this.context.sampleRate * chunkSeconds
    let buffers: Float32Array[] = []
    let collected = 0
    proc.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0)
      buffers.push(new Float32Array(data))
      collected += data.length
      if (collected >= targetSamples) {
        const merged = new Float32Array(collected)
        let offset = 0
        for (const b of buffers) {
          merged.set(b, offset)
          offset += b.length
        }
        buffers = []
        collected = 0
        onChunk(merged, this.context!.sampleRate)
      }
    }
    // ScriptProcessor only runs when routed to the destination; a zero-gain
    // sink keeps it silent.
    const sink = this.context.createGain()
    sink.gain.value = 0
    this.analyser.connect(proc)
    proc.connect(sink)
    sink.connect(this.context.destination)
    this.tapNode = proc
    this.tapSink = sink
  }

  stopPcmTap(): void {
    if (this.tapNode) {
      this.analyser?.disconnect(this.tapNode)
      this.tapNode.disconnect()
      this.tapNode.onaudioprocess = null
      this.tapNode = null
    }
    if (this.tapSink) {
      this.tapSink.disconnect()
      this.tapSink = null
    }
  }

  /** Take the frames accumulated since the last drain (one utterance). */
  drainFrames(): VoiceFrame[] {
    const frames = this.frames
    this.frames = []
    return frames
  }

  elapsedSeconds(): number {
    return (performance.now() - this.startedAt) / 1000
  }

  stop(): void {
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.stopPcmTap()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((t) => {
      t.removeEventListener('ended', this.handleTrackEnded)
      t.stop()
    })
    void this.context?.close()
    this.context = null
    this.stream = null
    this.analyser = null
    this.gainNode = null
    this.boostedOut = null
    this.frames = []
    this.level = 0
  }
}
