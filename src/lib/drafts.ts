import type { Speaker, TranscriptSegment } from '../types'

/**
 * Transcript drafts persisted in localStorage. Transcripts are plain text so
 * even long meetings are tiny; the audio recording itself is intentionally
 * NOT persisted (it would blow the storage quota).
 */

export interface Draft {
  id: string
  name: string
  savedAt: number
  segments: TranscriptSegment[]
  speakers: Speaker[]
}

const STORAGE_KEY = 'voxly-drafts'
export const MAX_DRAFTS = 20

export function readDrafts(): Draft[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Draft[]) : []
  } catch {
    return []
  }
}

export function writeDrafts(drafts: Draft[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    return true
  } catch {
    // Quota exceeded or storage unavailable.
    return false
  }
}

export function defaultDraftName(): string {
  return `Draft — ${new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}
