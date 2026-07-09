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
  const [exporting, setExporting] = useState(false)

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
                <span
                  className="speaker-chip"
                  style={{ backgroundColor: speaker?.color ?? '#888' }}
                >
                  {speaker?.name ?? '…'}
                </span>
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
