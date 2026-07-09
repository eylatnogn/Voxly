import { useVoxlyStore } from '../store'

export function SpeakerLegend() {
  const speakers = useVoxlyStore((s) => s.speakers)
  const renameSpeaker = useVoxlyStore((s) => s.renameSpeaker)

  if (speakers.length === 0) return null

  return (
    <div className="panel speaker-legend">
      <h2>Speakers</h2>
      <p className="hint">
        Live: tagged by pitch &amp; tone. Refined transcripts use neural voice fingerprints for
        higher accuracy. Click a name to edit it.
      </p>
      <ul>
        {speakers.map((speaker) => (
          <li key={speaker.id} className="speaker-row">
            <span className="speaker-dot" style={{ backgroundColor: speaker.color }} />
            <input
              className="speaker-name-input"
              value={speaker.name}
              onChange={(e) => renameSpeaker(speaker.id, e.target.value)}
              aria-label={`Rename ${speaker.name}`}
            />
            {speaker.medianPitchHz > 0 && (
              <span className="speaker-pitch">~{Math.round(speaker.medianPitchHz)} Hz</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
