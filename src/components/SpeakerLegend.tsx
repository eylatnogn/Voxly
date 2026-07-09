import { useVoxlyStore } from '../store'

export function SpeakerLegend() {
  const speakers = useVoxlyStore((s) => s.speakers)
  const renameSpeaker = useVoxlyStore((s) => s.renameSpeaker)

  if (speakers.length === 0) return null

  return (
    <div className="panel speaker-legend">
      <h2>Speakers</h2>
      <p className="hint">Detected from voice pitch &amp; tone. Click a name to edit it.</p>
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
            <span className="speaker-pitch">~{Math.round(speaker.medianPitchHz)} Hz</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
