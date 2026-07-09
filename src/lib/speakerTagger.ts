import type { VoiceFrame } from './pitch'

/**
 * Online speaker clustering from voice tone (spectral centroid) and pitch.
 *
 * Each speaker is modelled as a running centroid in a 2-D feature space:
 * log-pitch and log-spectral-centroid. Log space makes "distance" behave
 * perceptually (a 20 Hz gap matters a lot at 100 Hz, barely at 300 Hz).
 * A new utterance is assigned to the nearest cluster if it is within the
 * match radius, otherwise a new speaker is created (capped, so noise can't
 * mint endless speakers).
 *
 * Human pitch is not a fixed number — the same person's utterance medians
 * swing ±20–40% with emphasis, questions, and fatigue. The tagger is built
 * to forgive that: a wide match radius, octave-error folding, and merging of
 * clusters that drift together (callers are told via drainMerges so already
 * tagged transcript can be retagged).
 */

export interface SpeakerMatch {
  speakerId: number
  medianPitchHz: number
}

export interface SpeakerMerge {
  from: number
  to: number
}

interface Cluster {
  id: number
  logPitch: number
  logCentroid: number
  weight: number
  pitchSamples: number[]
}

const MAX_SPEAKERS = 8
/**
 * Distance in log-feature space below which an utterance confidently joins a
 * cluster (and refines it). 0.35 ≈ a 40% pitch difference — generous enough
 * for one voice's natural range.
 */
const MATCH_RADIUS = 0.35
/**
 * A NEW speaker is only created beyond this distance (~70% pitch difference,
 * roughly a typical male/female gap). Utterances landing between the two
 * radii are assigned to the nearest speaker without refining it — better to
 * occasionally lump two similar voices than to keep minting phantom speakers
 * from one person's expressive range.
 */
const NEW_SPEAKER_RADIUS = 0.55
/** Two clusters closer than this are the same voice that got split — merge. */
const MERGE_RADIUS = 0.25
/** Centroid (timbre) is ~10× noisier than pitch, so it only nudges distance. */
const CENTROID_WEIGHT = 0.2
const MIN_VOICED_FRAMES = 3

export class SpeakerTagger {
  private clusters: Cluster[] = []
  private nextId = 0
  private aliases = new Map<number, number>()
  private merges: SpeakerMerge[] = []

  /**
   * Classify one utterance from its voiced frames. Returns null when there
   * is not enough voiced evidence to make a call.
   */
  classify(frames: VoiceFrame[]): SpeakerMatch | null {
    const voiced = frames.filter((f) => f.pitchHz > 0 && f.centroidHz > 0)
    if (voiced.length < MIN_VOICED_FRAMES) return null

    const pitch = octaveFoldedMedian(voiced.map((f) => f.pitchHz))
    const centroid = median(voiced.map((f) => f.centroidHz))
    const logPitch = Math.log(pitch)
    const logCentroid = Math.log(centroid)

    let best: Cluster | null = null
    let bestDist = Infinity
    for (const cluster of this.clusters) {
      const dist = clusterDistance(cluster, logPitch, logCentroid)
      if (dist < bestDist) {
        bestDist = dist
        best = cluster
      }
    }

    let assigned: Cluster
    if (best && bestDist <= MATCH_RADIUS) {
      updateCluster(best, logPitch, logCentroid, pitch)
      assigned = best
    } else if (best && (bestDist <= NEW_SPEAKER_RADIUS || this.clusters.length >= MAX_SPEAKERS)) {
      // Borderline (or over the speaker cap): nearest speaker, but don't let
      // the ambiguous evidence drag the cluster around.
      assigned = best
    } else {
      assigned = {
        id: this.nextId++,
        logPitch,
        logCentroid,
        weight: 1,
        pitchSamples: [pitch],
      }
      this.clusters.push(assigned)
    }

    this.mergeNearbyClusters()
    const canonicalId = this.resolve(assigned.id)
    const canonical = this.clusters.find((c) => c.id === canonicalId) ?? assigned
    return { speakerId: canonicalId, medianPitchHz: median(canonical.pitchSamples) }
  }

  /** Follow merge aliases to the surviving cluster id. */
  resolve(id: number): number {
    let current = id
    while (this.aliases.has(current)) current = this.aliases.get(current)!
    return current
  }

  /**
   * Merges that happened since the last drain, oldest first. Callers should
   * retag existing transcript segments from `from` to `to`.
   */
  drainMerges(): SpeakerMerge[] {
    const merges = this.merges
    this.merges = []
    return merges
  }

  private mergeNearbyClusters(): void {
    let merged = true
    while (merged) {
      merged = false
      outer: for (let i = 0; i < this.clusters.length; i++) {
        for (let j = i + 1; j < this.clusters.length; j++) {
          const a = this.clusters[i]
          const b = this.clusters[j]
          const dist = clusterDistance(a, b.logPitch, b.logCentroid)
          if (dist >= MERGE_RADIUS) continue
          const [survivor, absorbed] = a.weight >= b.weight ? [a, b] : [b, a]
          const total = survivor.weight + absorbed.weight
          survivor.logPitch =
            (survivor.logPitch * survivor.weight + absorbed.logPitch * absorbed.weight) / total
          survivor.logCentroid =
            (survivor.logCentroid * survivor.weight + absorbed.logCentroid * absorbed.weight) /
            total
          survivor.weight = total
          survivor.pitchSamples = survivor.pitchSamples.concat(absorbed.pitchSamples).slice(-50)
          this.clusters.splice(this.clusters.indexOf(absorbed), 1)
          this.aliases.set(absorbed.id, survivor.id)
          this.merges.push({ from: absorbed.id, to: survivor.id })
          merged = true
          break outer
        }
      }
    }
  }

  reset(): void {
    this.clusters = []
    this.nextId = 0
    this.aliases.clear()
    this.merges = []
  }
}

function clusterDistance(cluster: Cluster, logPitch: number, logCentroid: number): number {
  const dp = logPitch - cluster.logPitch
  const dc = (logCentroid - cluster.logCentroid) * CENTROID_WEIGHT
  return Math.sqrt(dp * dp + dc * dc)
}

function updateCluster(cluster: Cluster, logPitch: number, logCentroid: number, pitch: number): void {
  // Exponential moving centroid: early utterances shape the cluster quickly,
  // later ones refine it without letting one odd utterance drag it away.
  const alpha = 1 / Math.min(cluster.weight + 1, 12)
  cluster.logPitch += (logPitch - cluster.logPitch) * alpha
  cluster.logCentroid += (logCentroid - cluster.logCentroid) * alpha
  cluster.weight += 1
  cluster.pitchSamples.push(pitch)
  if (cluster.pitchSamples.length > 50) cluster.pitchSamples.shift()
}

/**
 * Median that is robust to octave errors: autocorrelation pitch trackers
 * occasionally lock onto half or double the true fundamental, which used to
 * yank an utterance's median far enough to mint a phantom speaker. Fold such
 * frames back toward the raw median before taking the final median.
 */
function octaveFoldedMedian(pitches: number[]): number {
  const raw = median(pitches)
  const folded = pitches.map((p) => {
    if (p > raw * 1.6) return p / 2
    if (p < raw / 1.6) return p * 2
    return p
  })
  return median(folded)
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
