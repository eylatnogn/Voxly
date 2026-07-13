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
 * A sustained jump in log-pitch this large (~55%) splits a region even with
 * no silence — catching interruptions and back-to-back speaker handoffs.
 * Kept well above one voice's natural swing (questions and emphasis routinely
 * move pitch ±30%), and it must hold for two consecutive frames so a single
 * mis-tracked frame can't split a region.
 */
const PITCH_JUMP_LOG = 0.45
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
  // Clusters may have merged as evidence accumulated; point earlier regions
  // at the surviving speaker ids.
  for (const region of regions) {
    if (region.speakerId >= 0) region.speakerId = tagger.resolve(region.speakerId)
  }
  return regions
}

/**
 * Split a silence-free run of frames wherever the voice's pitch jumps
 * decisively — the strongest available cue that a different person took over
 * without a pause. Tracks a smoothed log-pitch so vibrato and gradual drift
 * don't cause splits, and requires TWO consecutive frames agreeing on the new
 * pitch before splitting, so one mis-tracked frame is absorbed as noise.
 */
function splitOnPitchJumps(group: VoiceFrame[]): VoiceFrame[][] {
  const out: VoiceFrame[][] = []
  let current: VoiceFrame[] = []
  let runLogPitch: number | null = null
  let pending: VoiceFrame[] = []
  let pendingLogPitch: number | null = null

  const absorbPending = () => {
    current.push(...pending)
    pending = []
    pendingLogPitch = null
  }

  for (const frame of group) {
    if (frame.pitchHz <= 0) {
      // Unvoiced frames tag along with whichever run is being built.
      ;(pending.length > 0 ? pending : current).push(frame)
      continue
    }
    const logPitch = Math.log(frame.pitchHz)
    if (runLogPitch === null) {
      runLogPitch = logPitch
      current.push(frame)
      continue
    }
    if (Math.abs(logPitch - runLogPitch) > PITCH_JUMP_LOG) {
      if (pendingLogPitch !== null && Math.abs(logPitch - pendingLogPitch) < 0.2) {
        // Second consecutive frame confirming the new voice — split here.
        if (current.length > 0) out.push(current)
        current = [...pending, frame]
        runLogPitch = (pendingLogPitch + logPitch) / 2
        pending = []
        pendingLogPitch = null
      } else {
        if (pending.length > 0) absorbPending()
        pending = [frame]
        pendingLogPitch = logPitch
      }
    } else {
      // Conforming frame: any lone outlier before it was tracker noise.
      if (pending.length > 0) absorbPending()
      current.push(frame)
      runLogPitch += (logPitch - runLogPitch) * 0.3
    }
  }
  if (pending.length > 0) absorbPending()
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

// ─── Sliding-window neural diarization ──────────────────────────────────
//
// The accurate pipeline (used for refined/uploaded transcripts):
//  1. Uniform ~2.4 s windows slide over SPEECH ONLY (silence skipped), so a
//     window rarely mixes two speakers the way variable-length regions did.
//  2. Each window gets an x-vector voice fingerprint (computed in the
//     worker); windows are capped adaptively so long meetings stay tractable.
//  3. Windows are clustered with an ADAPTIVE threshold learned from this
//     audio's own similarity distribution (2-means split of pairwise
//     similarities) instead of a fixed constant.
//  4. Labels are temporally smoothed, then refined by one reassignment pass
//     against cluster centroids.
//  5. Words are attributed by overlap-weighted vote over windows.

export interface EmbedWindow {
  start: number
  end: number
}

const WINDOW_SECONDS = 2.4
const MIN_WINDOW_SECONDS = 1.0
/** Cap on fingerprint inferences per file — hop stretches on long meetings. */
const MAX_WINDOWS = 400

/** Slide fixed windows across speech (frames mark speech; gaps are skipped). */
export function buildEmbeddingWindows(
  frames: VoiceFrame[],
  maxWindows: number = MAX_WINDOWS,
): EmbedWindow[] {
  if (frames.length === 0) return []
  // Group frames into speech spans separated by >0.6 s of silence.
  const spans: Array<{ start: number; end: number }> = []
  let spanStart = frames[0].time
  let last = frames[0].time
  for (const frame of frames) {
    if (frame.time - last > 0.6) {
      spans.push({ start: spanStart, end: last + 0.25 })
      spanStart = frame.time
    }
    last = frame.time
  }
  spans.push({ start: spanStart, end: last + 0.25 })

  const totalSpeech = spans.reduce((sum, s) => sum + (s.end - s.start), 0)
  const hop = Math.max(1.2, totalSpeech / maxWindows)

  const windows: EmbedWindow[] = []
  for (const span of spans) {
    for (let t = span.start; t < span.end; t += hop) {
      const end = Math.min(t + WINDOW_SECONDS, span.end)
      if (end - t >= MIN_WINDOW_SECONDS) windows.push({ start: t, end })
      if (end >= span.end) break
    }
    // Short spans still deserve one window if they're long enough.
    if (
      windows.length === 0 ||
      (windows[windows.length - 1].end <= span.start && span.end - span.start >= MIN_WINDOW_SECONDS)
    ) {
      windows.push({ start: span.start, end: span.end })
    }
  }
  return windows.slice(0, maxWindows)
}

/**
 * Cluster window fingerprints with a threshold learned from the data: the
 * pairwise cosine similarities split into "same speaker" and "different
 * speaker" modes; a 1-D 2-means finds the split point. If the two modes are
 * indistinguishable, the audio is a single speaker.
 */
export function adaptiveClusterEmbeddings(
  vectors: Array<number[] | null>,
  maxSpeakers = 8,
): number[] {
  const present = vectors
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number[]; i: number } => x.v !== null && x.v.length > 0)
  const ids = new Array<number>(vectors.length).fill(-1)
  if (present.length === 0) return ids
  if (present.length === 1) {
    ids[present[0].i] = 0
    return ids
  }

  const normed = present.map((p) => normalize(p.v))
  const sims: number[] = []
  for (let a = 0; a < normed.length; a++) {
    for (let b = a + 1; b < normed.length; b++) sims.push(dot(normed[a], normed[b]))
  }

  // 1-D 2-means on similarities → adaptive same/different threshold.
  let lo = Math.min(...sims)
  let hi = Math.max(...sims)
  for (let iter = 0; iter < 20; iter++) {
    let loSum = 0
    let loN = 0
    let hiSum = 0
    let hiN = 0
    const mid = (lo + hi) / 2
    for (const s of sims) {
      if (s < mid) {
        loSum += s
        loN++
      } else {
        hiSum += s
        hiN++
      }
    }
    if (loN === 0 || hiN === 0) break
    lo = loSum / loN
    hi = hiSum / hiN
  }
  // Modes too close together → one voice throughout.
  if (hi - lo < 0.08) {
    for (const p of present) ids[p.i] = 0
    return ids
  }
  const threshold = Math.min(0.8, Math.max(0.45, (lo + hi) / 2))

  const labels = agglomerate(normed, threshold, maxSpeakers)
  present.forEach((p, k) => {
    ids[p.i] = labels[k]
  })
  return ids
}

function agglomerate(normed: number[][], threshold: number, maxSpeakers: number): number[] {
  interface Cluster {
    indices: number[]
    centroid: number[]
  }
  const clusters: Cluster[] = normed.map((v, i) => ({ indices: [i], centroid: v }))

  const mergeClosest = (minSim: number): boolean => {
    let bestA = -1
    let bestB = -1
    let bestSim = minSim
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const sim = dot(clusters[a].centroid, clusters[b].centroid)
        if (sim >= bestSim) {
          bestSim = sim
          bestA = a
          bestB = b
        }
      }
    }
    if (bestA === -1) return false
    const [a, b] = [clusters[bestA], clusters[bestB]]
    const total = a.indices.length + b.indices.length
    a.centroid = normalize(
      a.centroid.map((v, i) => (v * a.indices.length + b.centroid[i] * b.indices.length) / total),
    )
    a.indices = a.indices.concat(b.indices)
    clusters.splice(bestB, 1)
    return true
  }

  while (clusters.length > 1 && mergeClosest(threshold)) {
    /* merge until nothing is similar enough */
  }
  // Tiny clusters are diarization noise — absorb into the nearest big one.
  for (let c = clusters.length - 1; c >= 0 && clusters.length > 1; c--) {
    if (clusters[c].indices.length >= 3) continue
    let best = -1
    let bestSim = -Infinity
    for (let o = 0; o < clusters.length; o++) {
      if (o === c) continue
      const sim = dot(clusters[c].centroid, clusters[o].centroid)
      if (sim > bestSim) {
        bestSim = sim
        best = o
      }
    }
    if (best !== -1) {
      clusters[best].indices = clusters[best].indices.concat(clusters[c].indices)
      clusters.splice(c, 1)
    }
  }
  while (clusters.length > maxSpeakers && mergeClosest(-1)) {
    /* forced merges over the cap */
  }

  clusters.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices))
  const labels = new Array<number>(normed.length).fill(0)
  clusters.forEach((cluster, id) => {
    for (const index of cluster.indices) labels[index] = id
  })

  // Refinement pass: reassign every window to its nearest cluster centroid.
  const centroids = clusters.map((c) =>
    normalize(
      c.indices
        .reduce(
          (acc, i) => acc.map((v, d) => v + normed[i][d]),
          new Array<number>(normed[0].length).fill(0),
        )
        .map((v) => v / c.indices.length),
    ),
  )
  for (let i = 0; i < normed.length; i++) {
    let best = labels[i]
    let bestSim = -Infinity
    for (let c = 0; c < centroids.length; c++) {
      const sim = dot(normed[i], centroids[c])
      if (sim > bestSim) {
        bestSim = sim
        best = c
      }
    }
    labels[i] = best
  }
  return labels
}

/** Median-of-three smoothing: a lone window flip between two windows of the
 * same speaker is noise, not a one-window interjection. */
export function smoothLabels(labels: number[]): number[] {
  const out = labels.slice()
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] !== out[i - 1] && out[i] !== out[i + 1] && out[i - 1] === out[i + 1]) {
      out[i] = out[i - 1]
    }
  }
  return out
}

/** Attribute each word by overlap-weighted vote across windows. */
export function assignWordSpeakers(
  words: TimedWord[],
  windows: EmbedWindow[],
  labels: number[],
): number[] {
  const ids = words.map((word) => {
    const votes = new Map<number, number>()
    const start = word.start - 0.15
    const end = word.end + 0.15
    for (let w = 0; w < windows.length; w++) {
      if (labels[w] < 0) continue
      const overlap = Math.min(end, windows[w].end) - Math.max(start, windows[w].start)
      if (overlap > 0) votes.set(labels[w], (votes.get(labels[w]) ?? 0) + overlap)
    }
    let best = -1
    let bestVote = 0
    for (const [label, vote] of votes) {
      if (vote > bestVote) {
        bestVote = vote
        best = label
      }
    }
    return best
  })
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === -1 && i > 0) ids[i] = ids[i - 1]
  }
  return ids
}

/** Group speaker-attributed words into transcript segments. */
export function groupWordsBySpeaker(
  words: TimedWord[],
  speakerIds: number[],
): TranscriptSegment[] {
  const ids = speakerIds.slice()
  absorbSingleWordFlips(ids)
  const segments: TranscriptSegment[] = []
  let bucket: TimedWord[] = []
  let bucketSpeaker = ids[0] ?? -1

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

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const pause = bucket.length > 0 ? word.start - bucket[bucket.length - 1].end : 0
    if (
      bucket.length > 0 &&
      (ids[i] !== bucketSpeaker || pause > SEGMENT_PAUSE_BREAK_SEC || bucket.length >= SEGMENT_MAX_WORDS)
    ) {
      flush()
    }
    if (bucket.length === 0) bucketSpeaker = ids[i]
    bucket.push(word)
  }
  flush()
  return segments
}

/**
 * Cluster neural voice fingerprints (x-vector embeddings) into speakers via
 * average-linkage agglomerative clustering on cosine similarity. Embeddings
 * capture timbre/resonance/speaking style — far more discriminative between
 * different voices than the pitch heuristic, which stays as the live tagger
 * and as fallback when the embedding model is unavailable.
 *
 * @param vectors one entry per region; null where no fingerprint could be
 * computed (region too short). Returns a cluster id per region, -1 for
 * fingerprint-less regions (caller inherits the previous region's speaker).
 */
export function clusterEmbeddings(
  vectors: Array<number[] | null>,
  similarityThreshold = 0.6,
  maxSpeakers = 8,
): number[] {
  interface Cluster {
    indices: number[]
    centroid: number[]
  }
  const clusters: Cluster[] = []
  vectors.forEach((vector, index) => {
    if (vector && vector.length > 0) {
      clusters.push({ indices: [index], centroid: normalize(vector) })
    }
  })

  const mergeClosest = (minSimilarity: number): boolean => {
    let bestA = -1
    let bestB = -1
    let bestSim = minSimilarity
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const sim = dot(clusters[a].centroid, clusters[b].centroid)
        if (sim >= bestSim) {
          bestSim = sim
          bestA = a
          bestB = b
        }
      }
    }
    if (bestA === -1) return false
    const [a, b] = [clusters[bestA], clusters[bestB]]
    const total = a.indices.length + b.indices.length
    const merged = a.centroid.map(
      (v, i) => (v * a.indices.length + b.centroid[i] * b.indices.length) / total,
    )
    a.centroid = normalize(merged)
    a.indices = a.indices.concat(b.indices)
    clusters.splice(bestB, 1)
    return true
  }

  while (clusters.length > 1 && mergeClosest(similarityThreshold)) {
    /* merge until no pair is similar enough */
  }
  // Over the cap, keep merging the closest pairs regardless of threshold.
  while (clusters.length > maxSpeakers && mergeClosest(-1)) {
    /* forced merges */
  }

  // Stable ids ordered by each cluster's first appearance in the audio.
  clusters.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices))
  const ids = new Array<number>(vectors.length).fill(-1)
  clusters.forEach((cluster, clusterId) => {
    for (const index of cluster.indices) ids[index] = clusterId
  })
  return ids
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
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
