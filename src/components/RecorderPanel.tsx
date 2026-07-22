import { useEffect, useRef, useState } from 'react'
import { LiveTranscriber, isLiveTranscriptionSupported } from '../lib/liveTranscriber'
import { transcribeFile } from '../lib/fileTranscriber'
import { currentDutyCycle } from '../lib/power'
import { useVoxlyStore } from '../store'
import { IconMic, IconRefine, IconScreen, IconStop, IconUpload } from './icons'

const LANGUAGES: Array<[code: string, label: string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['es-ES', 'Español'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['it-IT', 'Italiano'],
  ['pt-BR', 'Português (BR)'],
  ['zh-CN', '中文'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
  ['hi-IN', 'हिन्दी'],
]

function defaultLanguage(): string {
  const stored = localStorage.getItem('voxly-lang')
  if (stored) return stored
  const nav = navigator.language || 'en-US'
  return LANGUAGES.some(([code]) => code === nav) ? nav : 'en-US'
}

export function RecorderPanel() {
  const mode = useVoxlyStore((s) => s.mode)
  const setMode = useVoxlyStore((s) => s.setMode)
  const clearSession = useVoxlyStore((s) => s.clearSession)
  const setError = useVoxlyStore((s) => s.setError)
  const fileProgress = useVoxlyStore((s) => s.fileProgress)
  const fileStatus = useVoxlyStore((s) => s.fileStatus)
  const segments = useVoxlyStore((s) => s.segments)

  const recordingBlob = useVoxlyStore((s) => s.recordingBlob)
  const audioKind = useVoxlyStore((s) => s.audioKind)
  const transcriberRef = useRef<LiveTranscriber | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [micBoost, setMicBoost] = useState(1)
  const [captionEngine, setCaptionEngine] = useState<'browser' | 'on-device'>('browser')
  const [lang, setLang] = useState(defaultLanguage)
  const [elapsed, setElapsed] = useState(0)
  const [autoRefine, setAutoRefine] = useState(
    () => localStorage.getItem('voxly-auto-refine') !== 'off',
  )
  const lastRefinedRef = useRef<Blob | null>(null)
  const liveSupported = isLiveTranscriptionSupported()

  const changeAutoRefine = (on: boolean) => {
    setAutoRefine(on)
    localStorage.setItem('voxly-auto-refine', on ? 'on' : 'off')
  }

  // Bulletproofing: live captions are best-effort (the browser's recognizer
  // is a cloud service that can and does drop words), but the recording
  // captures everything. When a session ends, automatically run the
  // on-device Whisper pass over the recording so the final transcript never
  // depends on the lossy live path.
  useEffect(() => {
    if (mode !== 'idle' || !recordingBlob || audioKind !== 'live') return
    if (autoRefine) {
      // Skip token-sized recordings (accidental taps) and never re-run for
      // the same blob (refine restores it, which re-fires this effect).
      if (recordingBlob.size > 20000 && lastRefinedRef.current !== recordingBlob) {
        lastRefinedRef.current = recordingBlob
        refine()
      }
      return
    }
    if (segments.filter((s) => !s.interim).length === 0) {
      setError(
        'Live captions didn’t capture anything this session, but the audio was recorded. Select Refine transcript to process it on this device.',
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, recordingBlob])

  // Session clock — one tick per second, only while recording.
  useEffect(() => {
    if (mode !== 'live') {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [mode])

  const changeLang = (code: string) => {
    setLang(code)
    localStorage.setItem('voxly-lang', code)
  }

  // Poll the mic level for the meter — only while recording, at the interval
  // the power profile allows (0 = meter disabled in saver mode).
  useEffect(() => {
    if (mode !== 'live') {
      setMicLevel(0)
      return
    }
    const interval = currentDutyCycle().meterIntervalMs
    if (interval === 0) return
    const timer = window.setInterval(() => {
      setMicLevel(transcriberRef.current?.micLevel ?? 0)
      setMicBoost(transcriberRef.current?.micBoost ?? 1)
      setCaptionEngine(transcriberRef.current?.captionEngine ?? 'browser')
    }, interval)
    return () => clearInterval(timer)
  }, [mode])

  const startLive = async () => {
    clearSession()
    const transcriber = new LiveTranscriber()
    try {
      await transcriber.start(lang)
      transcriberRef.current = transcriber
      setMode('live')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not access the microphone.')
    }
  }

  const deviceAudioSupported =
    typeof navigator !== 'undefined' && 'getDisplayMedia' in (navigator.mediaDevices ?? {})

  /** Prompt for tab/system audio; null if cancelled or no audio shared. */
  const pickDisplayAudio = async (): Promise<MediaStream | null> => {
    let display: MediaStream
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch {
      return null // user cancelled the picker
    }
    // Only the audio is needed; drop video immediately so nothing heavy runs.
    display.getVideoTracks().forEach((t) => t.stop())
    const audioTracks = display.getAudioTracks()
    if (audioTracks.length === 0) {
      display.getTracks().forEach((t) => t.stop())
      setError(
        'No audio was shared. In the share picker, choose the meeting tab (or entire screen) and turn ON “Share audio”, then try again.',
      )
      return null
    }
    return new MediaStream(audioTracks)
  }

  /**
   * Transcribe the computer's own audio (a meeting tab, a video, any app
   * audio the browser can capture) — no microphone involved.
   */
  const startDeviceAudio = async () => {
    const external = await pickDisplayAudio()
    if (!external) return
    clearSession()
    const transcriber = new LiveTranscriber()
    try {
      await transcriber.start(lang, { external })
      transcriberRef.current = transcriber
      setMode('live')
    } catch (error) {
      external.getTracks().forEach((t) => t.stop())
      setError(error instanceof Error ? error.message : 'Could not capture device audio.')
    }
  }

  /**
   * MEETING MODE: microphone + the meeting's audio mixed into one session,
   * so both sides of a call are captured — headphones allowed.
   */
  const startMeetingMode = async () => {
    const external = await pickDisplayAudio()
    if (!external) return
    clearSession()
    const transcriber = new LiveTranscriber()
    try {
      await transcriber.start(lang, { external, mixMic: true })
      transcriberRef.current = transcriber
      setMode('live')
    } catch (error) {
      external.getTracks().forEach((t) => t.stop())
      setError(
        error instanceof Error
          ? error.message
          : 'Could not start meeting capture (microphone or shared audio unavailable).',
      )
    }
  }

  const stopLive = () => {
    transcriberRef.current?.stop()
    transcriberRef.current = null
    setMode('idle')
  }

  const onFileChosen = (file: File | undefined) => {
    if (!file) return
    void transcribeFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const refine = () => {
    if (!recordingBlob) return
    lastRefinedRef.current = recordingBlob
    const file = new File([recordingBlob], 'meeting-recording.webm', {
      type: recordingBlob.type || 'audio/webm',
    })
    void transcribeFile(file)
    // transcribeFile clears the session; keep the recording so refine can be
    // re-run (e.g. after a model-download failure).
    useVoxlyStore.getState().setRecordingBlob(recordingBlob, 'live')
  }

  return (
    <div className="panel recorder-panel">
      <h2>Capture</h2>

      <label className="lang-row">
        <span>Language</span>
        <select
          value={lang}
          onChange={(e) => changeLang(e.target.value)}
          disabled={mode !== 'idle'}
        >
          {LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="lang-row auto-refine-row" title="After you stop, the whole recording is re-transcribed on this device with the Whisper model. Nothing gets skipped — live captions become just a preview. First use downloads a ~40 MB model (then cached).">
        <span>Auto-refine after stop</span>
        <input
          type="checkbox"
          checked={autoRefine}
          onChange={(e) => changeAutoRefine(e.target.checked)}
        />
      </label>

      {mode === 'live' ? (
        <button className="btn btn-stop" onClick={stopLive}>
          <IconStop /> Stop recording
        </button>
      ) : (
        <button
          className="btn btn-record"
          onClick={() => void startLive()}
          disabled={mode === 'file'}
        >
          <IconMic /> Record meeting
        </button>
      )}
      {!liveSupported && mode !== 'live' && (
        <p className="hint">
          This browser has no native dictation, so live captions use the on-device engine
          (words appear every ~10 s).
        </p>
      )}
      {mode !== 'live' && (
        <p className="hint">
          Mic sensitivity adjusts automatically — quiet or distant voices are boosted, close
          voices are leveled.
        </p>
      )}

      {mode === 'live' && (
        <>
          <div className="rec-status">
            <span className="rec-dot" aria-hidden="true" />
            <span>
              Recording · {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}
            </span>
            {captionEngine === 'on-device' && (
              <span
                className="boost-badge engine-badge"
                title="Browser captions went quiet, so the on-device engine is captioning — words appear every ~10 s. Switches back automatically."
              >
                on-device
              </span>
            )}
            {micBoost > 1.2 && (
              <span
                className="boost-badge"
                title="Auto mic boost — the room is quiet, so the signal is being amplified for speaker analysis and the refine recording"
              >
                ×{micBoost.toFixed(1)} boost
              </span>
            )}
          </div>
          <div className="mic-meter" aria-hidden="true">
            <div className="mic-meter-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} />
          </div>
          {elapsed > 12 && segments.filter((s) => !s.interim).length === 0 && (
            <p className="hint">
              Captions warming up — the recording is already capturing everything, and the
              on-device engine steps in automatically if the browser stays quiet.
            </p>
          )}
        </>
      )}

      <div className="divider">or</div>

      {deviceAudioSupported && (
        <>
          <button
            className="btn btn-secondary"
            onClick={() => void startMeetingMode()}
            disabled={mode !== 'idle'}
            title="Records your microphone AND the meeting's audio together — both sides of the call in one transcript, headphones allowed. Pick the meeting tab (or entire screen) and enable “Share audio”."
          >
            <IconScreen /> Record me + meeting
          </button>
          <p className="hint">
            Captures your voice and the call audio together — ideal for Teams, Zoom, or Meet on
            this computer. Pick the meeting's tab (or entire screen) and enable “Share audio”.
            Make sure participants consent to being recorded.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => void startDeviceAudio()}
            disabled={mode !== 'idle'}
            title="Transcribe only what this computer is playing (no microphone) — pick the tab or screen and enable “Share audio”."
          >
            <IconScreen /> Capture device audio only
          </button>
        </>
      )}
      {!deviceAudioSupported && (
        <p className="hint">
          To capture a meeting playing on this phone: put it on speaker and use Record meeting.
        </p>
      )}

      <button
        className="btn btn-secondary"
        onClick={() => fileInputRef.current?.click()}
        disabled={mode !== 'idle'}
      >
        <IconUpload /> Transcribe audio file
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/webm,video/mp4"
        hidden
        onChange={(e) => onFileChosen(e.target.files?.[0])}
      />
      <p className="hint">
        Files are transcribed entirely on this device — nothing is uploaded.
      </p>

      {mode === 'file' && (
        <div className="file-progress">
          <span>{fileStatus ?? 'Working…'}</span>
          {fileProgress !== null && fileProgress > 0 && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${fileProgress}%` }} />
            </div>
          )}
        </div>
      )}

      {recordingBlob && audioKind === 'live' && mode === 'idle' && !autoRefine && (
        <>
          <button className="btn btn-refine" onClick={refine}>
            <IconRefine /> Refine transcript
          </button>
          <p className="hint">
            Re-transcribes the captured recording with the on-device Whisper model — catches
            words the live recognizer missed and tags speakers word-by-word. (English works
            best; runs locally.)
          </p>
        </>
      )}

      {segments.length > 0 && mode === 'idle' && (
        <button className="btn btn-ghost" onClick={clearSession}>
          Clear session
        </button>
      )}
    </div>
  )
}
