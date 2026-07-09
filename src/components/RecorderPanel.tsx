import { useEffect, useRef, useState } from 'react'
import { LiveTranscriber, isLiveTranscriptionSupported } from '../lib/liveTranscriber'
import { transcribeFile } from '../lib/fileTranscriber'
import { currentDutyCycle } from '../lib/power'
import { useVoxlyStore } from '../store'

export function RecorderPanel() {
  const mode = useVoxlyStore((s) => s.mode)
  const setMode = useVoxlyStore((s) => s.setMode)
  const clearSession = useVoxlyStore((s) => s.clearSession)
  const setError = useVoxlyStore((s) => s.setError)
  const fileProgress = useVoxlyStore((s) => s.fileProgress)
  const fileStatus = useVoxlyStore((s) => s.fileStatus)
  const segments = useVoxlyStore((s) => s.segments)

  const transcriberRef = useRef<LiveTranscriber | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const liveSupported = isLiveTranscriptionSupported()

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
    }, interval)
    return () => clearInterval(timer)
  }, [mode])

  const startLive = async () => {
    clearSession()
    const transcriber = new LiveTranscriber()
    try {
      await transcriber.start(navigator.language || 'en-US')
      transcriberRef.current = transcriber
      setMode('live')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not access the microphone.')
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

  return (
    <div className="panel recorder-panel">
      <h2>Capture</h2>

      {mode === 'live' ? (
        <button className="btn btn-stop" onClick={stopLive}>
          ■ Stop recording
        </button>
      ) : (
        <button
          className="btn btn-record"
          onClick={() => void startLive()}
          disabled={mode === 'file' || !liveSupported}
          title={liveSupported ? undefined : 'Web Speech API not available in this browser'}
        >
          ● Record meeting
        </button>
      )}
      {!liveSupported && (
        <p className="hint">
          Live dictation needs Chrome or Edge. Audio-file transcription works everywhere.
        </p>
      )}

      {mode === 'live' && (
        <div className="mic-meter" aria-hidden="true">
          <div className="mic-meter-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} />
        </div>
      )}

      <div className="divider">or</div>

      <button
        className="btn btn-secondary"
        onClick={() => fileInputRef.current?.click()}
        disabled={mode !== 'idle'}
      >
        ⬆ Transcribe audio file
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

      {segments.length > 0 && mode === 'idle' && (
        <button className="btn btn-ghost" onClick={clearSession}>
          Clear session
        </button>
      )}
    </div>
  )
}
