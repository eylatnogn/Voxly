import { create } from 'zustand'
import {
  defaultDraftName,
  MAX_DRAFTS,
  readDrafts,
  writeDrafts,
  type Draft,
} from './lib/drafts'
import type {
  EditSuggestion,
  PowerState,
  SessionMode,
  Speaker,
  TranscriptSegment,
} from './types'

export const SPEAKER_COLORS = [
  '#4f8ef7',
  '#e2557b',
  '#3bb273',
  '#e8a13c',
  '#9b6bd3',
  '#38b6b6',
  '#c96f4a',
  '#7a86e8',
]

interface VoxlyState {
  mode: SessionMode
  segments: TranscriptSegment[]
  speakers: Speaker[]
  suggestions: EditSuggestion[]
  power: PowerState
  fileProgress: number | null
  fileStatus: string | null
  error: string | null
  /** Audio captured during the last live session, for the refine pass. */
  recordingBlob: Blob | null
  drafts: Draft[]

  setMode: (mode: SessionMode) => void
  setError: (error: string | null) => void
  upsertSegment: (segment: TranscriptSegment) => void
  replaceSegments: (segments: TranscriptSegment[]) => void
  clearSession: () => void
  ensureSpeaker: (id: number, medianPitchHz: number) => void
  renameSpeaker: (id: number, name: string) => void
  /** Retag segments after two speaker clusters turn out to be the same voice. */
  remapSpeaker: (from: number, to: number) => void
  /** Manual correction: assign one transcript segment to a different speaker. */
  setSegmentSpeaker: (segmentId: string, speakerId: number) => void
  setSuggestions: (suggestions: EditSuggestion[]) => void
  applySuggestion: (suggestionId: string) => void
  dismissSuggestion: (suggestionId: string) => void
  setPower: (patch: Partial<PowerState>) => void
  setFileProgress: (progress: number | null, status?: string | null) => void
  setRecordingBlob: (blob: Blob | null) => void
  saveDraft: () => void
  loadDraft: (id: string) => void
  deleteDraft: (id: string) => void
  renameDraft: (id: string, name: string) => void
}

export const useVoxlyStore = create<VoxlyState>((set) => ({
  mode: 'idle',
  segments: [],
  speakers: [],
  suggestions: [],
  power: { profile: 'balanced', autoSaver: false, batteryLevel: null, charging: null },
  fileProgress: null,
  fileStatus: null,
  error: null,
  recordingBlob: null,
  drafts: readDrafts(),

  setMode: (mode) => set({ mode }),
  setError: (error) => set({ error }),

  upsertSegment: (segment) =>
    set((state) => {
      const index = state.segments.findIndex((s) => s.id === segment.id)
      if (index === -1) return { segments: [...state.segments, segment] }
      const segments = state.segments.slice()
      segments[index] = segment
      return { segments }
    }),

  replaceSegments: (segments) => set({ segments }),

  clearSession: () =>
    set({
      segments: [],
      speakers: [],
      suggestions: [],
      fileProgress: null,
      fileStatus: null,
      error: null,
      recordingBlob: null,
    }),

  ensureSpeaker: (id, medianPitchHz) =>
    set((state) => {
      const existing = state.speakers.find((s) => s.id === id)
      if (existing) {
        // Keep the pitch hint tracking the cluster as it accumulates evidence.
        const speakers = state.speakers.map((s) =>
          s.id === id ? { ...s, medianPitchHz } : s,
        )
        return { speakers }
      }
      return {
        speakers: [
          ...state.speakers,
          {
            id,
            name: `Speaker ${id + 1}`,
            color: SPEAKER_COLORS[id % SPEAKER_COLORS.length],
            medianPitchHz,
          },
        ],
      }
    }),

  renameSpeaker: (id, name) =>
    set((state) => ({
      speakers: state.speakers.map((s) => (s.id === id ? { ...s, name } : s)),
    })),

  remapSpeaker: (from, to) =>
    set((state) => ({
      segments: state.segments.map((s) =>
        s.speakerId === from ? { ...s, speakerId: to } : s,
      ),
      speakers: state.speakers.filter((s) => s.id !== from),
    })),

  setSegmentSpeaker: (segmentId, speakerId) =>
    set((state) => ({
      segments: state.segments.map((s) =>
        s.id === segmentId ? { ...s, speakerId } : s,
      ),
    })),

  setSuggestions: (suggestions) => set({ suggestions }),

  applySuggestion: (suggestionId) =>
    set((state) => {
      const suggestion = state.suggestions.find((s) => s.id === suggestionId)
      if (!suggestion || suggestion.replacement === null) {
        return { suggestions: state.suggestions.filter((s) => s.id !== suggestionId) }
      }
      const segments = state.segments.map((segment) => {
        if (segment.id !== suggestion.segmentId) return segment
        const text =
          segment.text.slice(0, suggestion.start) +
          suggestion.replacement +
          segment.text.slice(suggestion.end)
        return { ...segment, text: text.replace(/ {2,}/g, ' ').trim() }
      })
      // Offsets in sibling suggestions are now stale; the analyzer re-runs
      // against the edited text, so drop everything for that segment.
      const suggestions = state.suggestions.filter(
        (s) => s.segmentId !== suggestion.segmentId,
      )
      return { segments, suggestions }
    }),

  dismissSuggestion: (suggestionId) =>
    set((state) => ({
      suggestions: state.suggestions.filter((s) => s.id !== suggestionId),
    })),

  setPower: (patch) => set((state) => ({ power: { ...state.power, ...patch } })),

  setFileProgress: (progress, status) =>
    set((state) => ({
      fileProgress: progress,
      fileStatus: status === undefined ? state.fileStatus : status,
    })),

  setRecordingBlob: (blob) => set({ recordingBlob: blob }),

  saveDraft: () =>
    set((state) => {
      const segments = state.segments.filter((s) => !s.interim)
      if (segments.length === 0) return {}
      const draft: Draft = {
        id: `draft-${Date.now().toString(36)}`,
        name: defaultDraftName(),
        savedAt: Date.now(),
        segments,
        speakers: state.speakers,
      }
      const drafts = [draft, ...state.drafts].slice(0, MAX_DRAFTS)
      if (!writeDrafts(drafts)) {
        return { error: 'Could not save the draft — browser storage is full or unavailable.' }
      }
      return { drafts }
    }),

  loadDraft: (id) =>
    set((state) => {
      const draft = state.drafts.find((d) => d.id === id)
      if (!draft) return {}
      return {
        segments: draft.segments,
        speakers: draft.speakers,
        suggestions: [],
        mode: 'idle',
        recordingBlob: null,
        error: null,
        fileProgress: null,
        fileStatus: null,
      }
    }),

  deleteDraft: (id) =>
    set((state) => {
      const drafts = state.drafts.filter((d) => d.id !== id)
      writeDrafts(drafts)
      return { drafts }
    }),

  renameDraft: (id, name) =>
    set((state) => {
      const drafts = state.drafts.map((d) => (d.id === id ? { ...d, name } : d))
      writeDrafts(drafts)
      return { drafts }
    }),
}))
