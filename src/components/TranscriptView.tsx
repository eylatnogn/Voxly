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

  const stats = useMemo(() => {
    const finals = segments.filter((s) => !s.interim)
    const words = finals.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
    const duration = finals.length > 0 ? Math.max(...finals.map((s) => s.endTime)) : 0
    return { words, duration }
  }, [segments])

  if (segments.length === 0) {
    return (
      <div className="panel transcript-empty">
        <h2>Transcript</h2>
        <div className="empty-hero">
          <span className="empty-mark" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </span>
          <h3>Capture the conversation, keep the meaning</h3>
          <p>
            Record a meeting or drop in an audio file. Voxly transcribes it on this device,
            figures out who's speaking from their voice tone and pitch, and flags the filler
            so your script reads clean.
          </p>
          <div className="empty-steps">
            <div className="empty-step">
              <span className="step-num">1</span>
              <h4>Capture</h4>
              <p>Record live, or upload a recording — wav, mp3, m4a, ogg, webm, flac.</p>
            </div>
            <div className="empty-step">
              <span className="step-num">2</span>
              <h4>Identify</h4>
              <p>Speakers are tagged by voice. Rename them, or fix a tag right on the transcript.</p>
            </div>
            <div className="empty-step">
              <span className="step-num">3</span>
              <h4>Clean up</h4>
              <p>One-click fixes for fillers and stumbles, then export as text, subtitles, or Word.</p>
            </div>
          </div>
        </div>
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
      <div className="stats-row">
        <span className="stat-chip"><strong>{formatTime(stats.duration)}</strong> duration</span>
        <span className="stat-chip"><strong>{stats.words.toLocaleString()}</strong> words</span>
        <span className="stat-chip"><strong>{speakers.length}</strong> {speakers.length === 1 ? 'speaker' : 'speakers'}</span>
        <span className="stat-chip"><strong>{suggestions.length}</strong> {suggestions.length === 1 ? 'suggestion' : 'suggestions'}</span>
      </div>
      <div className="transcript-scroll">
        {segments.map((segment) => {
          const speaker = speakerById.get(segment.speakerId)
          return (
            <article
              key={segment.id}
              className={`segment${segment.interim ? ' segment-interim' : ''}`}
              style={{ borderLeftColor: speaker?.color ?? 'transparent' }}
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
                {flaggedSegmentIds.has(segment.id) && (
                  <span className="segment-flag">✎ needs cleanup</span>
                )}
              </div>
              <p className="segment-text">{segment.text}</p>
            </article>
          )
        })}
      </div>
    </div>
  )
}
