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

export class LiveTranscriber {
  private recognition: SpeechRecognitionLike | null = null
  private mic = new MicFeatureCapture()
  private tagger = new SpeakerTagger()
  private running = false
  private segmentCounter = 0
  private currentSegmentStart = 0
  private lastSpeakerId = -1

  get micLevel(): number {
    return this.mic.level
  }

  async start(lang: string): Promise<void> {
    const Ctor = getSpeechRecognition()
    if (!Ctor) throw new Error('This browser does not support the Web Speech API. Try Chrome or Edge, or use the audio-file mode.')

    await this.mic.start()
    this.tagger.reset()
    this.running = true
    this.currentSegmentStart = 0

    const recognition = new Ctor()
    recognition.lang = lang
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => this.handleResult(event)
    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine; anything else is worth surfacing.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        useVoxlyStore.getState().setError(`Speech recognition error: ${event.error}`)
      }
    }
    recognition.onend = () => {
      // Chrome ends recognition after silence; restart while the session is live.
      if (this.running) {
        try {
          recognition.start()
        } catch {
          /* already started */
        }
      }
    }

    this.recognition = recognition
    recognition.start()
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const store = useVoxlyStore.getState()
    let interimText = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue

      if (result.isFinal) {
        const frames = this.mic.drainFrames()
        const match = this.tagger.classify(frames)
        const speakerId = match ? match.speakerId : this.lastSpeakerId
        if (match) {
          store.ensureSpeaker(match.speakerId, match.medianPitchHz)
          this.lastSpeakerId = match.speakerId
        }
        const now = this.mic.elapsedSeconds()
        const segment: TranscriptSegment = {
          id: `live-${this.segmentCounter++}`,
          speakerId,
          text: capitalize(text),
          startTime: this.currentSegmentStart,
          endTime: now,
        }
        this.currentSegmentStart = now
        store.upsertSegment(segment)
        this.removeInterim()
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

  private removeInterim(): void {
    const store = useVoxlyStore.getState()
    store.replaceSegments(store.segments.filter((s) => s.id !== 'live-interim'))
  }

  stop(): void {
    this.running = false
    this.recognition?.stop()
    this.recognition = null
    this.mic.stop()
    this.removeInterim()
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
