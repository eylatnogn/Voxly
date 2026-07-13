import { useVoxlyStore } from '../store'

export function SpeakerLegend() {
  const speakers = useVoxlyStore((s) => s.speakers)
  const renameSpeaker = useVoxlyStore((s) => s.renameSpeaker)
  const remapSpeaker = useVoxlyStore((s) => s.remapSpeaker)

  if (speakers.length === 0) return null

  const mergeInto = (fromId: number, value: string) => {
    if (!value) return
    remapSpeaker(fromId, Number(value))
  }

  return (
    <div className="panel speaker-legend">
      <h2>Speakers</h2>
      <p className="hint">
        Live: tagged by pitch &amp; tone. Refined transcripts use neural voice fingerprints for
        higher accuracy. Click a name to edit it{speakers.length > 1 ? '; Merge retags every line of one speaker as another' : ''}.
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
            {speakers.length > 1 && (
              <select
                className="speaker-merge"
                value=""
                onChange={(e) => mergeInto(speaker.id, e.target.value)}
                title={`Misidentified? Move ALL of ${speaker.name}'s lines to another speaker`}
                aria-label={`Merge ${speaker.name} into another speaker`}
              >
                <option value="" disabled>
                  Merge
                </option>
                {speakers
                  .filter((other) => other.id !== speaker.id)
                  .map((other) => (
                    <option key={other.id} value={other.id}>
                      Into {other.name}
                    </option>
                  ))}
              </select>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
