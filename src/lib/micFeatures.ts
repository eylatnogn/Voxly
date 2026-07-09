import { analyzeFrame, type VoiceFrame } from './pitch'
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
  private timer: number | null = null
  private frames: VoiceFrame[] = []
  private startedAt = 0
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(2048)

  /** Latest RMS level (0..1) for the UI meter. */
  level = 0

  /** The live microphone stream, shared with the session recorder. */
  get mediaStream(): MediaStream | null {
    return this.stream
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.context = new AudioContext()
    const source = this.context.createMediaStreamSource(this.stream)
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 2048
    source.connect(this.analyser)
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
    const frame = analyzeFrame(this.buffer, this.context.sampleRate, time)
    this.level = frame ? Math.min(1, frame.energy * 8) : 0
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
    this.frames = []
    this.level = 0
  }
}
