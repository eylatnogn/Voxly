import type { Speaker, TranscriptSegment } from '../types'

/**
 * On-device meeting minutes, PLAUD-style: overview, key points, action items
 * with owners, decisions, and open questions — generated the moment the
 * transcript changes, with templates for meetings, lectures, and interviews.
 *
 * Everything is extractive + pattern-based (word-frequency sentence scoring,
 * cue-phrase detection), so it runs instantly, offline, and never sends the
 * transcript anywhere.
 */

export type SummaryTemplate = 'meeting' | 'lecture' | 'interview'

export interface ActionItem {
  text: string
  ownerId: number
}

export interface QaPair {
  question: string
  answer: string
  askerId: number
  answererId: number
}

export interface SummaryResult {
  overview: string[]
  keyPoints: string[]
  actionItems: ActionItem[]
  decisions: string[]
  questions: string[]
  qaPairs: QaPair[]
}

interface Sentence {
  text: string
  speakerId: number
  order: number
  score: number
  words: Set<string>
}

const STOP_WORDS = new Set(
  (
    'the a an and or but if so to of in on at for with is are was were be been being it its this that these those ' +
    'i you he she we they them his her our your their my me us do does did have has had will would can could should ' +
    'shall may might must not no yes okay ok um uh like just really very also then than there here what when where ' +
    'which who how why all any some as from by about into over after before up down out off again going get got ' +
    'think know want say said see one two thing things stuff bit lot'
  ).split(' '),
)

const ACTION_RE =
  /\b(will|we'll|i'll|going to|need(?:s)? to|has to|have to|let's|let us|make sure|follow(?:ing)? up|schedule|send|review|prepare|set up|reach out|assign(?:ed)?|due|deadline|action item|take care of|get back to|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of|eod|eow))\b/i

const IMPERATIVE_RE =
  /^(send|schedule|review|prepare|set|create|update|draft|share|check|confirm|book|invite|email|call|follow|finish|complete|assign|collect|organize|write)\b/i

const DECISION_RE =
  /\b(decided|decision|agreed?(?:s|d)? (?:to|on|that)|approved|confirmed|finali[sz]ed|going with|settled on|signed off|green.?light|consensus)\b/i

export function summarize(
  segments: TranscriptSegment[],
  template: SummaryTemplate,
): SummaryResult {
  const sentences = splitSentences(segments)
  const empty: SummaryResult = {
    overview: [],
    keyPoints: [],
    actionItems: [],
    decisions: [],
    questions: [],
    qaPairs: [],
  }
  if (sentences.length === 0) return empty

  scoreSentences(sentences)

  const actionItems: ActionItem[] = []
  const decisions: string[] = []
  const questions: Sentence[] = []
  const prose: Sentence[] = []
  for (const sentence of sentences) {
    if (/\?\s*$/.test(sentence.text)) {
      questions.push(sentence)
    } else if (DECISION_RE.test(sentence.text)) {
      decisions.push(sentence.text)
    } else if (ACTION_RE.test(sentence.text) || IMPERATIVE_RE.test(sentence.text)) {
      actionItems.push({ text: sentence.text, ownerId: sentence.speakerId })
    } else {
      prose.push(sentence)
    }
  }

  const ranked = prose.slice().sort((a, b) => b.score - a.score)
  const overview = pickDistinct(ranked, 3)
  const keyPointCount = template === 'lecture' ? 8 : template === 'interview' ? 5 : 6
  const keyPoints = pickDistinct(
    ranked.filter((s) => !overview.includes(s)),
    keyPointCount,
  )

  const qaPairs: QaPair[] = []
  if (template === 'interview') {
    for (const question of questions) {
      const answer = sentences.find(
        (s) =>
          s.order > question.order &&
          s.order <= question.order + 3 &&
          s.speakerId !== question.speakerId &&
          !/\?\s*$/.test(s.text),
      )
      if (answer) {
        qaPairs.push({
          question: question.text,
          answer: answer.text,
          askerId: question.speakerId,
          answererId: answer.speakerId,
        })
      }
    }
  }

  const chronological = (list: Sentence[]) =>
    list.slice().sort((a, b) => a.order - b.order).map((s) => s.text)

  return {
    overview: chronological(overview),
    keyPoints: chronological(keyPoints),
    actionItems: actionItems.slice(0, 12),
    decisions: decisions.slice(0, 8),
    questions: questions
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, template === 'interview' ? 12 : 5)
      .sort((a, b) => a.order - b.order)
      .map((s) => s.text),
    qaPairs: qaPairs.slice(0, 10),
  }
}

export function summaryIsEmpty(summary: SummaryResult): boolean {
  return (
    summary.overview.length === 0 &&
    summary.keyPoints.length === 0 &&
    summary.actionItems.length === 0 &&
    summary.decisions.length === 0 &&
    summary.questions.length === 0
  )
}

/** Render the summary as plain text (for clipboard and .txt export). */
export function summaryToText(summary: SummaryResult, speakers: Speaker[]): string {
  const name = (id: number) => speakers.find((s) => s.id === id)?.name ?? 'Unassigned'
  const parts: string[] = []
  if (summary.overview.length > 0) {
    parts.push('OVERVIEW', ...summary.overview.map((s) => `  ${s}`))
  }
  if (summary.keyPoints.length > 0) {
    parts.push('', 'KEY POINTS', ...summary.keyPoints.map((s) => `  - ${s}`))
  }
  if (summary.actionItems.length > 0) {
    parts.push(
      '',
      'ACTION ITEMS',
      ...summary.actionItems.map((a) => `  [ ] ${a.text} (${name(a.ownerId)})`),
    )
  }
  if (summary.decisions.length > 0) {
    parts.push('', 'DECISIONS', ...summary.decisions.map((s) => `  - ${s}`))
  }
  if (summary.qaPairs.length > 0) {
    parts.push('', 'Q & A', ...summary.qaPairs.flatMap((p) => [`  Q: ${p.question}`, `  A: ${p.answer}`]))
  } else if (summary.questions.length > 0) {
    parts.push('', 'OPEN QUESTIONS', ...summary.questions.map((s) => `  - ${s}`))
  }
  return parts.join('\n')
}

function splitSentences(segments: TranscriptSegment[]): Sentence[] {
  const sentences: Sentence[] = []
  let order = 0
  for (const segment of segments) {
    if (segment.interim) continue
    const pieces = segment.text.split(/(?<=[.!?])\s+/)
    for (const piece of pieces) {
      const text = piece.trim()
      if (text.split(/\s+/).length < 4) continue
      sentences.push({
        text,
        speakerId: segment.speakerId,
        order: order++,
        score: 0,
        words: new Set(
          text
            .toLowerCase()
            .replace(/[^a-z0-9\s']/g, '')
            .split(/\s+/)
            .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
        ),
      })
    }
  }
  return sentences
}

function scoreSentences(sentences: Sentence[]): void {
  const freq = new Map<string, number>()
  for (const sentence of sentences) {
    for (const word of sentence.words) freq.set(word, (freq.get(word) ?? 0) + 1)
  }
  for (const sentence of sentences) {
    let sum = 0
    for (const word of sentence.words) sum += freq.get(word) ?? 0
    sentence.score = sentence.words.size > 0 ? sum / Math.sqrt(sentence.words.size + 3) : 0
    // Numbers, money, and percentages usually carry the substance.
    if (/\d/.test(sentence.text)) sentence.score *= 1.25
  }
}

/** Take the top sentences, skipping near-duplicates (Jaccard > 0.6). */
function pickDistinct(ranked: Sentence[], count: number): Sentence[] {
  const picked: Sentence[] = []
  for (const candidate of ranked) {
    if (picked.length >= count) break
    const isDupe = picked.some((p) => {
      let overlap = 0
      for (const w of candidate.words) if (p.words.has(w)) overlap++
      const union = p.words.size + candidate.words.size - overlap
      return union > 0 && overlap / union > 0.6
    })
    if (!isDupe) picked.push(candidate)
  }
  return picked
}
