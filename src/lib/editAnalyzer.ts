import type { EditSuggestion, SuggestionKind, TranscriptSegment } from '../types'

/**
 * Rule-based transcript cleanup. Everything here is plain string scanning —
 * no model, no network — so it can run in idle time on every transcript
 * change without meaningful battery cost.
 */

const FILLERS = [
  'um', 'uh', 'umm', 'uhh', 'er', 'erm', 'hmm', 'mhm',
  'you know', 'i mean', 'like i said', 'sort of', 'kind of', 'kinda', 'sorta',
]

const HEDGES = [
  'i think maybe', 'i guess', 'i suppose', 'probably maybe',
  'just wanted to', 'i just think', 'to be honest', 'basically',
  'literally', 'actually',
]

const WEAK_PHRASES: Array<{ pattern: RegExp; replacement: string; message: string }> = [
  { pattern: /\bin order to\b/gi, replacement: 'to', message: '"in order to" can usually be just "to"' },
  { pattern: /\bat this point in time\b/gi, replacement: 'now', message: 'Wordy — "now" says the same thing' },
  { pattern: /\bdue to the fact that\b/gi, replacement: 'because', message: 'Wordy — "because" is cleaner' },
  { pattern: /\bcircle back\b/gi, replacement: 'follow up', message: 'Jargon — consider "follow up"' },
  { pattern: /\btouch base\b/gi, replacement: 'check in', message: 'Jargon — consider "check in"' },
  { pattern: /\bgoing forward\b/gi, replacement: 'from now on', message: 'Jargon — consider "from now on" or cutting it' },
]

const RUN_ON_WORD_LIMIT = 40

let counter = 0
function nextId(kind: SuggestionKind): string {
  return `${kind}-${++counter}`
}

export function analyzeSegments(segments: TranscriptSegment[]): EditSuggestion[] {
  const suggestions: EditSuggestion[] = []
  for (const segment of segments) {
    if (segment.interim || !segment.text.trim()) continue
    findFillers(segment, suggestions)
    findStutters(segment, suggestions)
    findRepeatedWords(segment, suggestions)
    findHedges(segment, suggestions)
    findWeakPhrases(segment, suggestions)
    findRunOns(segment, suggestions)
    findSpacing(segment, suggestions)
  }
  return suggestions
}

function pushMatch(
  suggestions: EditSuggestion[],
  segment: TranscriptSegment,
  kind: SuggestionKind,
  start: number,
  end: number,
  replacement: string | null,
  message: string,
): void {
  suggestions.push({
    id: nextId(kind),
    segmentId: segment.id,
    kind,
    start,
    end,
    excerpt: segment.text.slice(start, end),
    replacement,
    message,
  })
}

function findFillers(segment: TranscriptSegment, out: EditSuggestion[]): void {
  for (const filler of FILLERS) {
    const re = new RegExp(`(?:^|\\s)(${escapeRe(filler)})(?=[\\s,.!?]|$)`, 'gi')
    for (const m of segment.text.matchAll(re)) {
      const start = m.index + m[0].indexOf(m[1])
      // Take a leading space (if any) with the deletion so no double space is left.
      const delStart = start > 0 && segment.text[start - 1] === ' ' ? start - 1 : start
      let delEnd = start + m[1].length
      // Also swallow a trailing comma glued to the filler ("um, so...").
      if (segment.text[delEnd] === ',') delEnd += 1
      pushMatch(out, segment, 'filler', delStart, delEnd, '', `Filler word — remove "${m[1]}"`)
    }
  }
}

/** "I I think", "the the plan" — same word twice back to back. */
function findStutters(segment: TranscriptSegment, out: EditSuggestion[]): void {
  const re = /\b(\w+)([,.]?\s+)\1\b/gi
  for (const m of segment.text.matchAll(re)) {
    // Deliberate doubles like "very very" or "no no" are common speech; only
    // flag short function-word stutters and identical case repeats.
    pushMatch(
      out,
      segment,
      'stutter',
      m.index,
      m.index + m[0].length,
      m[1],
      `Repeated word — keep one "${m[1]}"`,
    )
  }
}

/** The same notable word appearing 3+ times within one segment. */
function findRepeatedWords(segment: TranscriptSegment, out: EditSuggestion[]): void {
  const words = segment.text.toLowerCase().match(/\b[a-z']{5,}\b/g) ?? []
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  for (const [word, count] of counts) {
    if (count < 3) continue
    const idx = segment.text.toLowerCase().indexOf(word)
    if (idx === -1) continue
    pushMatch(
      out,
      segment,
      'repeated-word',
      idx,
      idx + word.length,
      null,
      `"${word}" appears ${count}× in this passage — consider varying the wording`,
    )
  }
}

function findHedges(segment: TranscriptSegment, out: EditSuggestion[]): void {
  for (const hedge of HEDGES) {
    const re = new RegExp(`(?:^|\\s)(${escapeRe(hedge)})(?=[\\s,.!?]|$)`, 'gi')
    for (const m of segment.text.matchAll(re)) {
      const start = m.index + m[0].indexOf(m[1])
      pushMatch(
        out,
        segment,
        'hedge',
        start,
        start + m[1].length,
        null,
        `Hedging phrase — "${m[1]}" may weaken the point`,
      )
    }
  }
}

function findWeakPhrases(segment: TranscriptSegment, out: EditSuggestion[]): void {
  for (const { pattern, replacement, message } of WEAK_PHRASES) {
    pattern.lastIndex = 0
    for (const m of segment.text.matchAll(pattern)) {
      pushMatch(out, segment, 'weak-phrase', m.index, m.index + m[0].length, replacement, message)
    }
  }
}

function findRunOns(segment: TranscriptSegment, out: EditSuggestion[]): void {
  const sentences = segment.text.split(/(?<=[.!?])\s+/)
  let offset = 0
  for (const sentence of sentences) {
    const wordCount = sentence.split(/\s+/).filter(Boolean).length
    if (wordCount > RUN_ON_WORD_LIMIT) {
      const start = segment.text.indexOf(sentence, offset)
      if (start !== -1) {
        pushMatch(
          out,
          segment,
          'run-on',
          start,
          start + Math.min(sentence.length, 80),
          null,
          `Long sentence (${wordCount} words) — consider splitting it up`,
        )
      }
    }
    offset += sentence.length
  }
}

function findSpacing(segment: TranscriptSegment, out: EditSuggestion[]): void {
  for (const m of segment.text.matchAll(/ {2,}|\s+(?=[,.!?])/g)) {
    const isDoubleSpace = m[0].includes('  ')
    pushMatch(
      out,
      segment,
      'spacing',
      m.index,
      m.index + m[0].length,
      isDoubleSpace ? ' ' : '',
      isDoubleSpace ? 'Extra whitespace' : 'Space before punctuation',
    )
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
