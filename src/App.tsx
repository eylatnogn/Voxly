import { useCallback, useEffect, useRef } from 'react'
import { RecorderPanel } from './components/RecorderPanel'
import { TranscriptView } from './components/TranscriptView'
import { SuggestionsPanel } from './components/SuggestionsPanel'
import { SpeakerLegend } from './components/SpeakerLegend'
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">▍▌▊</span>
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
          <SpeakerLegend />
        </aside>
        <section className="transcript-column">
          <TranscriptView />
        </section>
        <aside className="suggestions-column">
          <SuggestionsPanel />
        </aside>
      </main>
    </div>
  )
}
