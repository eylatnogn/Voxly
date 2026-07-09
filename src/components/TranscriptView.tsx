import { useMemo, useState } from 'react'
import {
  downloadBlob,
  transcriptToDocx,
  transcriptToSrt,
  transcriptToTxt,
} from '../lib/exporters'
import { useVoxlyStore } from '../store'
import type { Speaker } from '../types'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function TranscriptView() {
  const segments = useVoxlyStore((s) => s.segments)
  const speakers = useVoxlyStore((s) => s.speakers)
  const suggestions = useVoxlyStore((s) => s.suggestions)
  const setError = useVoxlyStore((s) => s.setError)
  const setSegmentSpeaker = useVoxlyStore((s) => s.setSegmentSpeaker)
  const ensureSpeaker = useVoxlyStore((s) => s.ensureSpeaker)
  const [exporting, setExporting] = useState(false)

  const changeSegmentSpeaker = (segmentId: string, value: string) => {
    if (value === 'new') {
      const nextId = speakers.length > 0 ? Math.max(...speakers.map((s) => s.id)) + 1 : 0
      ensureSpeaker(nextId, 0)
      setSegmentSpeaker(segmentId, nextId)
    } else {
      setSegmentSpeaker(segmentId, Number(value))
    }
  }

  const speakerById = useMemo(() => {
    const map = new Map<number, Speaker>()
    for (const speaker of speakers) map.set(speaker.id, speaker)
    return map
  }, [speakers])

  const flaggedSegmentIds = useMemo(
    () => new Set(suggestions.map((s) => s.segmentId)),
    [suggestions],
  )

  const exportTxt = () => {
    downloadBlob(
      new Blob([transcriptToTxt(segments, speakers)], { type: 'text/plain' }),
      'voxly-transcript.txt',
    )
  }

  const exportSrt = () => {
    downloadBlob(
      new Blob([transcriptToSrt(segments, speakers)], { type: 'application/x-subrip' }),
      'voxly-transcript.srt',
    )
  }

  const exportDocx = async () => {
    setExporting(true)
    try {
      downloadBlob(await transcriptToDocx(segments, speakers), 'voxly-transcript.docx')
    } catch {
      setError('Word export failed — the exporter module could not be loaded.')
    } finally {
      setExporting(false)
    }
  }

  if (segments.length === 0) {
    return (
      <div className="panel transcript-empty">
        <h2>Transcript</h2>
        <p>
          Start a recording or drop in an audio file. Voxly will transcribe it, tag who is
          speaking from their voice tone and pitch, and suggest edits to clean up the script.
        </p>
      </div>
    )
  }

  return (
    <div className="panel transcript-view">
      <div className="transcript-header">
        <h2>Transcript</h2>
        <div className="export-buttons">
          <button className="btn btn-ghost" onClick={exportTxt}>⬇ .txt</button>
          <button className="btn btn-ghost" onClick={exportSrt}>⬇ .srt</button>
          <button className="btn btn-ghost" onClick={() => void exportDocx()} disabled={exporting}>
            {exporting ? '…' : '⬇ Word'}
          </button>
        </div>
      </div>
      <div className="transcript-scroll">
        {segments.map((segment) => {
          const speaker = speakerById.get(segment.speakerId)
          return (
            <article
              key={segment.id}
              className={`segment${segment.interim ? ' segment-interim' : ''}${
                flaggedSegmentIds.has(segment.id) ? ' segment-flagged' : ''
              }`}
            >
              <div className="segment-meta">
                <select
                  className="speaker-chip speaker-chip-select"
                  style={{ backgroundColor: speaker?.color ?? '#888' }}
                  value={segment.speakerId}
                  disabled={segment.interim}
                  onChange={(e) => changeSegmentSpeaker(segment.id, e.target.value)}
                  aria-label="Change speaker for this passage"
                  title="Wrong speaker? Reassign this passage."
                >
                  {segment.speakerId === -1 && <option value={-1}>…</option>}
                  {speakers.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                    </option>
                  ))}
                  <option value="new">+ New speaker</option>
                </select>
                <span className="segment-time">{formatTime(segment.startTime)}</span>
              </div>
              <p className="segment-text">{segment.text}</p>
            </article>
          )
        })}
      </div>
    </div>
  )
}
