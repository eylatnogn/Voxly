import { useCallback, useEffect, useRef } from 'react'
import { RecorderPanel } from './components/RecorderPanel'
import { TranscriptView } from './components/TranscriptView'
import { SuggestionsPanel } from './components/SuggestionsPanel'
import { SpeakerLegend } from './components/SpeakerLegend'
import { DraftsPanel } from './components/DraftsPanel'
import { PlaybackPanel } from './components/PlaybackPanel'
import { PowerBadge } from './components/PowerBadge'
import { analyzeSegments } from './lib/editAnalyzer'
import { currentDutyCycle, initPowerMonitor, runWhenIdle } from './lib/power'
import { useVoxlyStore } from './store'

export default function App() {
  const segments = useVoxlyStore((s) => s.segments)
  const error = useVoxlyStore((s) => s.error)
  const setError = useVoxlyStore((s) => s.setError)
  const setSuggestions = useVoxlyStore((s) => s.setSuggestions)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    void initPowerMonitor()
  }, [])

  // Re-analyze the transcript for cleanup suggestions — debounced by the
  // power profile and pushed into browser idle time.
  const scheduleAnalysis = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      runWhenIdle(() => {
        const current = useVoxlyStore.getState().segments
        setSuggestions(analyzeSegments(current))
      })
    }, currentDutyCycle().analyzeDebounceMs)
  }, [setSuggestions])

  useEffect(() => {
    scheduleAnalysis()
  }, [segments, scheduleAnalysis])

  const mode = useVoxlyStore((s) => s.mode)

  return (
    <div className={`app${mode === 'live' ? ' app-recording' : ''}`}>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </span>
          <h1>Voxly</h1>
          <span className="tagline">Meeting transcription analyzer</span>
        </div>
        <PowerBadge />
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">✕</button>
        </div>
      )}

      <main className="layout">
        <aside className="sidebar">
          <RecorderPanel />
          <PlaybackPanel />
          <SpeakerLegend />
          <DraftsPanel />
        </aside>
        <section className="transcript-column">
          <TranscriptView />
        </section>
        <aside className="suggestions-column">
          <SuggestionsPanel />
        </aside>
      </main>

      <footer className="app-footer">
        <span>🔒 Everything runs on this device — audio and transcripts never leave your browser.</span>
        <span>🔋 Battery-first: analysis idles when you do.</span>
      </footer>
    </div>
  )
}
