import { useVoxlyStore } from '../store'

function formatSavedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function DraftsPanel() {
  const drafts = useVoxlyStore((s) => s.drafts)
  const loadDraft = useVoxlyStore((s) => s.loadDraft)
  const deleteDraft = useVoxlyStore((s) => s.deleteDraft)
  const renameDraft = useVoxlyStore((s) => s.renameDraft)
  const mode = useVoxlyStore((s) => s.mode)

  if (drafts.length === 0) return null

  return (
    <div className="panel drafts-panel">
      <h2>Drafts</h2>
      <p className="hint">Saved on this device. Click a name to rename it.</p>
      <ul>
        {drafts.map((draft) => (
          <li key={draft.id} className="draft-row">
            <div className="draft-main">
              <input
                className="draft-name-input"
                value={draft.name}
                onChange={(e) => renameDraft(draft.id, e.target.value)}
                aria-label={`Rename ${draft.name}`}
              />
              <span className="draft-meta">
                {draft.segments.length} {draft.segments.length === 1 ? 'passage' : 'passages'} ·{' '}
                {formatSavedAt(draft.savedAt)}
              </span>
            </div>
            <div className="draft-actions">
              <button
                className="btn-tiny"
                onClick={() => loadDraft(draft.id)}
                disabled={mode !== 'idle'}
                title="Open this draft (replaces the current transcript)"
              >
                Open
              </button>
              <button
                className="btn-tiny btn-tiny-ghost"
                onClick={() => deleteDraft(draft.id)}
                title="Delete this draft"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
