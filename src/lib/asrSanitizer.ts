/**
 * Whisper hallucination scrubber.
 *
 * On audio without real speech (silence, hold music, notification tones,
 * compressed meeting hum), Whisper's decoder falls into repetition loops —
 * inventing a phrase and emitting it dozens of times ("VIDEO biasesVIDEO
 * biases…"). Two signatures give it away:
 *
 *  1. The same 1–4 word phrase repeating back-to-back more than twice.
 *  2. Long output built from a tiny vocabulary (low unique-word ratio).
 *
 * Real speech almost never trips either: deliberate repetition ("no, no,
 * no") survives (two repeats are kept), and normal sentences have far more
 * distinct words.
 */

/** Immediate phrase repeats beyond this many occurrences are collapsed. */
const MAX_PHRASE_REPEATS = 2
/** Texts at least this long with unique-word ratio below the floor are junk. */
const RATIO_CHECK_MIN_WORDS = 12
const UNIQUE_RATIO_FLOOR = 0.3

export function sanitizeAsrText(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''

  // Collapse runaway back-to-back phrase loops (period 1–4 words).
  const out: string[] = []
  for (const word of words) {
    out.push(word)
    for (let n = 1; n <= 4; n++) {
      if (out.length < n * (MAX_PHRASE_REPEATS + 1)) continue
      const tail = out.slice(-n).join(' ').toLowerCase()
      let repeats = 1
      while (
        repeats <= MAX_PHRASE_REPEATS &&
        out.slice(-(repeats + 1) * n, -repeats * n).join(' ').toLowerCase() === tail
      ) {
        repeats++
      }
      if (repeats > MAX_PHRASE_REPEATS) {
        out.length -= n
        break
      }
    }
  }

  // If collapsing removed most of the text and all that's left is the looped
  // phrase itself, the whole chunk was hallucination — drop it entirely.
  const removed = words.length - out.length
  if (removed / words.length > 0.5) {
    const uniqueOut = new Set(out.map((w) => w.toLowerCase()))
    if (out.length <= 8 && uniqueOut.size <= 4) return ''
  }

  // Loop output that survived collapsing still reveals itself through a
  // starved vocabulary.
  if (out.length >= RATIO_CHECK_MIN_WORDS) {
    const unique = new Set(out.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')))
    unique.delete('')
    if (unique.size / out.length < UNIQUE_RATIO_FLOOR) return ''
  }

  return out.join(' ')
}

/** Lowercased, punctuation-stripped form for comparing chunk outputs. */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whisper's stock outputs for silence, noise, and music — short stereotyped
 * phrases it was trained into by subtitle credits. A chunk consisting of
 * nothing but one of these is near-certainly not something anyone said.
 */
const SILENCE_PHRASES = new Set([
  'you',
  'bye',
  'bye bye',
  'thank you',
  'thank you bye',
  'thanks',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'see you next time',
  'see you in the next video',
  'please subscribe',
  'subscribe',
  'music',
  'applause',
  'silence',
  'the end',
  "we'll see you next time",
  "i'll see you next time",
])

export function isLikelySilenceHallucination(text: string): boolean {
  const normalized = normalizeForDedupe(text)
  if (!normalized) return true
  if (normalized.split(' ').length > 7) return false
  return SILENCE_PHRASES.has(normalized)
}
