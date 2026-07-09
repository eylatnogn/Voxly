import {
  analyzeFrame,
  DEFAULT_ENERGY_GATE,
  FAR_FIELD_ENERGY_GATE,
  type VoiceFrame,
} from './pitch'
import { currentDutyCycle } from './power'

/**
 * Captures the microphone and extracts voice frames (pitch + timbre) at a
 * battery-friendly duty cycle. Instead of processing every audio callback,
 * an AnalyserNode buffers the signal continuously in native code (cheap) and
 * we only pull + analyze a snapshot a few times per second from a JS timer.
 *
 * Frames are buffered per-utterance; the live transcriber drains them when a
 * phrase is finalized to decide who was speaking.
 */
export class MicFeatureCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private boostedOut: MediaStreamAudioDestinationNode | null = null
  private timer: number | null = null
  private frames: VoiceFrame[] = []
  private startedAt = 0
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(2048)
  private energyGate = DEFAULT_ENERGY_GATE
  private levelScale = 8

  /** Latest RMS level (0..1) for the UI meter. */
  level = 0

  /**
   * Stream for the session recorder. In high-sensitivity mode this is the
   * amplified signal (gain + soft limiter), so the refine pass hears distant
   * voices at full level; otherwise the raw microphone.
   */
  get recordingStream(): MediaStream | null {
    return this.boostedOut?.stream ?? this.stream
  }

  /**
   * @param highSensitivity Far-field mode for picking up distant voices: a
   * 4× amplifier + soft limiter boosts the signal for voice analysis and the
   * session recording, and the analysis energy gate drops.
   *
   * IMPORTANT: capture constraints are identical in both modes. Requesting a
   * "raw" stream (noise suppression / echo cancellation off) reconfigures the
   * shared microphone session on mobile and starves the platform speech
   * recognizer — high mode used to kill live transcription entirely because
   * of this. All boosting therefore happens in our own WebAudio graph, which
   * cannot affect the recognizer's feed.
   */
  async start(highSensitivity = false): Promise<void> {
    // The 4× boost happens upstream of the analyser in high mode, so the
    // gate/meter see an already-amplified signal.
    this.energyGate = highSensitivity ? FAR_FIELD_ENERGY_GATE : DEFAULT_ENERGY_GATE
    this.levelScale = highSensitivity ? 8 : 8
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.context = new AudioContext()
    const source = this.context.createMediaStreamSource(this.stream)
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 2048
    if (highSensitivity) {
      // Amplify before analysis/recording: 4× gain lifts distant voices, and
      // a compressor acting as a soft limiter stops nearby speech from
      // clipping. The pitch tracker, level meter, and the session recording
      // all read the boosted signal.
      const gain = this.context.createGain()
      gain.gain.value = 4
      const limiter = this.context.createDynamicsCompressor()
      limiter.threshold.value = -12
      limiter.knee.value = 10
      limiter.ratio.value = 8
      limiter.attack.value = 0.004
      limiter.release.value = 0.2
      this.boostedOut = this.context.createMediaStreamDestination()
      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(this.analyser)
      limiter.connect(this.boostedOut)
    } else {
      source.connect(this.analyser)
    }
    this.startedAt = performance.now()
    this.scheduleNext()

    // Tab hidden = user is not looking; suspend the audio graph and timers
    // entirely. SpeechRecognition keeps transcribing independently.
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  private onVisibility = () => {
    if (!this.context) return
    if (document.hidden) {
      void this.context.suspend()
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
    } else {
      void this.context.resume()
      this.scheduleNext()
    }
  }

  private scheduleNext(): void {
    const fps = currentDutyCycle().analysisFps
    this.timer = window.setTimeout(() => {
      this.captureFrame()
      if (this.context) this.scheduleNext()
    }, 1000 / fps)
  }

  private captureFrame(): void {
    if (!this.analyser || !this.context) return
    this.analyser.getFloatTimeDomainData(this.buffer)
    const time = (performance.now() - this.startedAt) / 1000
    const frame = analyzeFrame(this.buffer, this.context.sampleRate, time, this.energyGate)
    this.level = frame ? Math.min(1, frame.energy * this.levelScale) : 0
    if (frame) {
      this.frames.push(frame)
      // Bound memory if no utterance boundary arrives for a long time.
      if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 600)
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
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.context?.close()
    this.context = null
    this.stream = null
    this.analyser = null
    this.boostedOut = null
    this.frames = []
    this.level = 0
  }
}
