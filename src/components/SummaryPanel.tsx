import { useMemo, useState } from 'react'
import {
  summarize,
  summaryIsEmpty,
  summaryToText,
  type SummaryTemplate,
} from '../lib/summarizer'
import { useVoxlyStore } from '../store'
import { IconCheck } from './icons'

const TEMPLATES: Array<[SummaryTemplate, string]> = [
  ['meeting', 'Meeting minutes'],
  ['lecture', 'Lecture notes'],
  ['interview', 'Interview'],
]

export function SummaryPanel() {
  const segments = useVoxlyStore((s) => s.segments)
  const speakers = useVoxlyStore((s) => s.speakers)
  const [template, setTemplate] = useState<SummaryTemplate>(
    () => (localStorage.getItem('voxly-summary-template') as SummaryTemplate) || 'meeting',
  )
  const [copied, setCopied] = useState(false)

  const changeTemplate = (t: SummaryTemplate) => {
    setTemplate(t)
    localStorage.setItem('voxly-summary-template', t)
  }

  const summary = useMemo(() => summarize(segments, template), [segments, template])
  const speakerName = (id: number) => speakers.find((s) => s.id === id)?.name ?? 'Unassigned'
  const speakerColor = (id: number) => speakers.find((s) => s.id === id)?.color ?? '#888'

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryToText(summary, speakers))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  if (segments.filter((s) => !s.interim).length === 0) {
    return (
      <div className="panel transcript-empty">
        <h2>Summary</h2>
        <p className="hint">
          Once there is a transcript, this tab turns it into structured minutes: an overview,
          key points, action items with owners, decisions, and open questions — generated on
          this device, instantly.
        </p>
      </div>
    )
  }

  return (
    <div className="panel summary-panel">
      <div className="transcript-header">
        <h2>Summary</h2>
        <div className="export-buttons">
          <select
            className="template-select"
            value={template}
            onChange={(e) => changeTemplate(e.target.value as SummaryTemplate)}
            aria-label="Summary template"
          >
            {TEMPLATES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => void copySummary()}>
            {copied ? (
              <>
                <IconCheck /> Copied
              </>
            ) : (
              'Copy summary'
            )}
          </button>
        </div>
      </div>

      {summaryIsEmpty(summary) ? (
        <p className="hint">Not enough transcript yet to summarize — keep going.</p>
      ) : (
        <div className="summary-sections">
          {summary.overview.length > 0 && (
            <section className="summary-section">
              <h3>Overview</h3>
              {summary.overview.map((s, i) => (
                <p key={i} className="summary-prose">
                  {s}
                </p>
              ))}
            </section>
          )}

          {summary.keyPoints.length > 0 && (
            <section className="summary-section">
              <h3>Key points</h3>
              <ul className="summary-list">
                {summary.keyPoints.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}

          {summary.actionItems.length > 0 && (
            <section className="summary-section">
              <h3>Action items</h3>
              <ul className="summary-list summary-actions">
                {summary.actionItems.map((a, i) => (
                  <li key={i}>
                    <span className="action-text">{a.text}</span>
                    <span
                      className="owner-chip"
                      style={{ backgroundColor: speakerColor(a.ownerId) }}
                    >
                      {speakerName(a.ownerId)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary.decisions.length > 0 && (
            <section className="summary-section">
              <h3>Decisions</h3>
              <ul className="summary-list">
                {summary.decisions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}

          {summary.qaPairs.length > 0 ? (
            <section className="summary-section">
              <h3>Questions &amp; answers</h3>
              <ul className="summary-list summary-qa">
                {summary.qaPairs.map((p, i) => (
                  <li key={i}>
                    <p className="qa-q">
                      <strong>{speakerName(p.askerId)}:</strong> {p.question}
                    </p>
                    <p className="qa-a">
                      <strong>{speakerName(p.answererId)}:</strong> {p.answer}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            summary.questions.length > 0 && (
              <section className="summary-section">
                <h3>Open questions</h3>
                <ul className="summary-list">
                  {summary.questions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </section>
            )
          )}
        </div>
      )}
    </div>
  )
}
