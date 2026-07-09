import { useMemo } from 'react'
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

  const speakerById = useMemo(() => {
    const map = new Map<number, Speaker>()
    for (const speaker of speakers) map.set(speaker.id, speaker)
    return map
  }, [speakers])

  const flaggedSegmentIds = useMemo(
    () => new Set(suggestions.map((s) => s.segmentId)),
    [suggestions],
  )

  const exportTranscript = () => {
    const lines = segments
      .filter((s) => !s.interim)
      .map((s) => {
        const speaker = speakerById.get(s.speakerId)
        const name = speaker ? speaker.name : 'Unknown speaker'
        return `[${formatTime(s.startTime)}] ${name}: ${s.text}`
      })
    const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'voxly-transcript.txt'
    a.click()
    URL.revokeObjectURL(url)
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
        <button className="btn btn-ghost" onClick={exportTranscript}>
          ⬇ Export .txt
        </button>
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
