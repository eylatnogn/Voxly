import type { VoiceFrame } from './pitch'
import { SpeakerTagger } from './speakerTagger'
import type { TranscriptSegment } from '../types'

/**
 * Word-level speaker diarization for file transcriptions.
 *
 * Voice frames (pitch + timbre, sampled every 0.25 s) are grouped into voiced
 * regions separated by silence, each region is classified into a speaker
 * cluster, and then every transcribed word is attributed to the region its
 * midpoint falls in. Runs of same-speaker words become transcript segments —
 * so a speaker change in the middle of a Whisper chunk (or a sentence) is
 * still caught.
 */

export interface TimedWord {
  text: string
  start: number
  end: number
}

export interface VoicedRegion {
  start: number
  end: number
  speakerId: number
  medianPitchHz: number
}

/** Silence longer than this splits two voiced regions. */
const REGION_GAP_SEC = 0.75
/**
 * A sustained jump in log-pitch this large (~35%) splits a region even with
 * no silence — catching interruptions and back-to-back speaker handoffs.
 */
const PITCH_JUMP_LOG = 0.3
/** A word farther than this from any voiced region keeps the previous speaker. */
const NEAREST_REGION_TOLERANCE_SEC = 1.0
/** A pause longer than this starts a new segment even for the same speaker. */
const SEGMENT_PAUSE_BREAK_SEC = 1.5
/** Hard cap so one monologue doesn't become an unreadable wall of text. */
const SEGMENT_MAX_WORDS = 120

export function buildVoicedRegions(
  frames: VoiceFrame[],
  tagger: SpeakerTagger,
): VoicedRegion[] {
  const groups: VoiceFrame[][] = []
  let current: VoiceFrame[] = []
  for (const frame of frames) {
    if (current.length > 0 && frame.time - current[current.length - 1].time > REGION_GAP_SEC) {
      groups.push(current)
      current = []
    }
    current.push(frame)
  }
  if (current.length > 0) groups.push(current)

  const regions: VoicedRegion[] = []
  for (const group of groups.flatMap(splitOnPitchJumps)) {
    const match = tagger.classify(group)
    regions.push({
      start: group[0].time,
      end: group[group.length - 1].time,
      // Too little voiced evidence (e.g. a cough): assume the previous speaker.
      speakerId: match
        ? match.speakerId
        : regions.length > 0
          ? regions[regions.length - 1].speakerId
          : -1,
      medianPitchHz: match ? match.medianPitchHz : 0,
    })
  }
  return regions
}

/**
 * Split a silence-free run of frames wherever the voice's pitch jumps
 * decisively — the strongest available cue that a different person took over
 * without a pause. Tracks a smoothed log-pitch so vibrato and octave-stable
 * drift don't cause splits.
 */
function splitOnPitchJumps(group: VoiceFrame[]): VoiceFrame[][] {
  const out: VoiceFrame[][] = []
  let current: VoiceFrame[] = []
  let runLogPitch: number | null = null
  for (const frame of group) {
    if (frame.pitchHz > 0) {
      const logPitch = Math.log(frame.pitchHz)
      if (runLogPitch !== null && Math.abs(logPitch - runLogPitch) > PITCH_JUMP_LOG) {
        if (current.length > 0) out.push(current)
        current = []
        runLogPitch = logPitch
      } else {
        runLogPitch =
          runLogPitch === null ? logPitch : runLogPitch + (logPitch - runLogPitch) * 0.3
      }
    }
    current.push(frame)
  }
  if (current.length > 0) out.push(current)
  return out
}

export function speakerAt(time: number, regions: VoicedRegion[]): number {
  let nearest = -1
  let nearestDist = Infinity
  for (const region of regions) {
    if (time >= region.start && time <= region.end) return region.speakerId
    const dist = time < region.start ? region.start - time : time - region.end
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = region.speakerId
    }
  }
  return nearestDist <= NEAREST_REGION_TOLERANCE_SEC ? nearest : -1
}

/** Word-level path: group speaker-attributed words into transcript segments. */
export function wordsToSegments(
  words: TimedWord[],
  regions: VoicedRegion[],
): TranscriptSegment[] {
  const clean = words.filter((w) => w.text.trim())
  if (clean.length === 0) return []

  const speakerIds = clean.map((w) => speakerAt((w.start + w.end) / 2, regions))
  for (let i = 0; i < speakerIds.length; i++) {
    if (speakerIds[i] === -1 && i > 0) speakerIds[i] = speakerIds[i - 1]
  }
  absorbSingleWordFlips(speakerIds)

  const segments: TranscriptSegment[] = []
  let bucket: TimedWord[] = []
  let bucketSpeaker = speakerIds[0]

  const flush = () => {
    if (bucket.length === 0) return
    segments.push({
      id: `file-${segments.length}`,
      speakerId: bucketSpeaker,
      text: bucket.map((w) => w.text).join(' ').replace(/ {2,}/g, ' ').trim(),
      startTime: bucket[0].start,
      endTime: bucket[bucket.length - 1].end,
    })
    bucket = []
  }

  for (let i = 0; i < clean.length; i++) {
    const word = clean[i]
    const pause = bucket.length > 0 ? word.start - bucket[bucket.length - 1].end : 0
    if (
      bucket.length > 0 &&
      (speakerIds[i] !== bucketSpeaker ||
        pause > SEGMENT_PAUSE_BREAK_SEC ||
        bucket.length >= SEGMENT_MAX_WORDS)
    ) {
      flush()
    }
    if (bucket.length === 0) bucketSpeaker = speakerIds[i]
    bucket.push(word)
  }
  flush()
  return segments
}

/**
 * A lone word tagged to a different speaker than everything around it is far
 * more likely diarization noise than a real one-word interjection; absorb it
 * into the larger neighboring run.
 */
function absorbSingleWordFlips(ids: number[]): void {
  for (let i = 1; i < ids.length - 1; i++) {
    if (ids[i] !== ids[i - 1] && ids[i] !== ids[i + 1]) ids[i] = ids[i - 1]
  }
}

/**
 * Fallback path when word timestamps are unavailable: attribute each whole
 * chunk to the speaker with the most voiced-region overlap, then merge
 * adjacent chunks from the same speaker.
 */
export function chunksToSegments(
  chunks: Array<{ text: string; start: number; end: number }>,
  regions: VoicedRegion[],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let lastSpeakerId = -1
  for (const chunk of chunks) {
    const text = chunk.text.trim()
    if (!text) continue
    const votes = new Map<number, number>()
    for (const region of regions) {
      const overlap = Math.min(chunk.end, region.end) - Math.max(chunk.start, region.start)
      if (overlap > 0) votes.set(region.speakerId, (votes.get(region.speakerId) ?? 0) + overlap)
    }
    let speakerId = lastSpeakerId
    let bestOverlap = 0
    for (const [id, overlap] of votes) {
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        speakerId = id
      }
    }
    lastSpeakerId = speakerId

    const previous = segments[segments.length - 1]
    if (previous && previous.speakerId === speakerId && chunk.start - previous.endTime < 2) {
      previous.text = `${previous.text} ${text}`.replace(/ {2,}/g, ' ')
      previous.endTime = chunk.end
    } else {
      segments.push({
        id: `file-${segments.length}`,
        speakerId,
        text,
        startTime: chunk.start,
        endTime: chunk.end,
      })
    }
  }
  return segments
}
