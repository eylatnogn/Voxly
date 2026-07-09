/** A contiguous chunk of transcript attributed to one speaker. */
export interface TranscriptSegment {
  id: string
  /** Cluster id assigned by the speaker tagger; -1 = unknown. */
  speakerId: number
  text: string
  /** Seconds from session start (live) or file start (upload). */
  startTime: number
  endTime: number
  /** True while a live segment is still being spoken (interim result). */
  interim?: boolean
}

/** A speaker discovered by voice-profile clustering. */
export interface Speaker {
  id: number
  /** User-editable display name; defaults to "Speaker N". */
  name: string
  color: string
  /** Median fundamental frequency of the cluster, Hz — shown as a hint. */
  medianPitchHz: number
}

export type SuggestionKind =
  | 'filler'
  | 'stutter'
  | 'repeated-word'
  | 'hedge'
  | 'run-on'
  | 'weak-phrase'
  | 'spacing'

export interface EditSuggestion {
  id: string
  segmentId: string
  kind: SuggestionKind
  /** Character offsets within the segment's text. */
  start: number
  end: number
  /** The problematic excerpt as it currently reads. */
  excerpt: string
  /** Replacement text; empty string means "delete". Null means advisory only. */
  replacement: string | null
  message: string
}

export type SessionMode = 'idle' | 'live' | 'file'

export type PowerProfile = 'balanced' | 'saver'

export interface PowerState {
  profile: PowerProfile
  /** True when the Battery API reports discharging below the saver threshold. */
  autoSaver: boolean
  batteryLevel: number | null
  charging: boolean | null
}
