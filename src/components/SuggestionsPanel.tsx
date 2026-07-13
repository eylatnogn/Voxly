import { useVoxlyStore } from '../store'
import type { SuggestionKind } from '../types'

const KIND_LABELS: Record<SuggestionKind, string> = {
  filler: 'Filler',
  stutter: 'Stutter',
  'repeated-word': 'Repetition',
  hedge: 'Hedging',
  'run-on': 'Run-on',
  'weak-phrase': 'Wordy',
  spacing: 'Spacing',
}

export function SuggestionsPanel() {
  const suggestions = useVoxlyStore((s) => s.suggestions)
  const applySuggestion = useVoxlyStore((s) => s.applySuggestion)
  const dismissSuggestion = useVoxlyStore((s) => s.dismissSuggestion)
  const segments = useVoxlyStore((s) => s.segments)

  const applyAllFixable = () => {
    // Apply one per segment per pass; offsets go stale after each apply, and
    // the analyzer refreshes remaining suggestions on the next idle cycle.
    const seen = new Set<string>()
    for (const suggestion of suggestions) {
      if (suggestion.replacement === null || seen.has(suggestion.segmentId)) continue
      seen.add(suggestion.segmentId)
      applySuggestion(suggestion.id)
    }
  }

  const fixableCount = suggestions.filter((s) => s.replacement !== null).length

  return (
    <div className="panel suggestions-panel">
      <div className="suggestions-header">
        <h2>Cleanup suggestions</h2>
        {fixableCount > 0 && (
          <button className="btn btn-ghost" onClick={applyAllFixable}>
            Fix next batch
          </button>
        )}
      </div>

      {suggestions.length === 0 ? (
        <p className="hint">
          {segments.length === 0
            ? 'Suggestions appear here once there is a transcript to analyze.'
            : 'No cleanup suggestions — the script reads clean.'}
        </p>
      ) : (
        <>
          <div className="suggestion-summary">
            {Object.entries(
              suggestions.reduce<Record<string, number>>((acc, s) => {
                acc[s.kind] = (acc[s.kind] ?? 0) + 1
                return acc
              }, {}),
            ).map(([kind, count]) => (
              <span key={kind} className="summary-chip">
                <strong>{count}</strong> {KIND_LABELS[kind as SuggestionKind].toLowerCase()}
              </span>
            ))}
          </div>
          <ul className="suggestion-list">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id} className={`suggestion suggestion-${suggestion.kind}`}>
              <div className="suggestion-top">
                <span className="suggestion-kind">{KIND_LABELS[suggestion.kind]}</span>
                <div className="suggestion-actions">
                  {suggestion.replacement !== null && (
                    <button
                      className="btn-tiny"
                      onClick={() => applySuggestion(suggestion.id)}
                      title={
                        suggestion.replacement === ''
                          ? 'Delete this text'
                          : `Replace with "${suggestion.replacement}"`
                      }
                    >
                      Fix
                    </button>
                  )}
                  <button
                    className="btn-tiny btn-tiny-ghost"
                    onClick={() => dismissSuggestion(suggestion.id)}
                  >
                    Ignore
                  </button>
                </div>
              </div>
              <p className="suggestion-message">{suggestion.message}</p>
              <blockquote className="suggestion-excerpt">
                “{suggestion.excerpt.trim() || '␣'}”
                {suggestion.replacement ? <> → “{suggestion.replacement}”</> : null}
              </blockquote>
            </li>
          ))}
          </ul>
        </>
      )}
    </div>
  )
}
