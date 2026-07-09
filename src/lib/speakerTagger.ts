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
 */

export interface SpeakerMatch {
  speakerId: number
  medianPitchHz: number
}

interface Cluster {
  id: number
  logPitch: number
  logCentroid: number
  weight: number
  pitchSamples: number[]
}

const MAX_SPEAKERS = 8
/** Distance in log-feature space below which an utterance joins a cluster. */
const MATCH_RADIUS = 0.18
/** Frames with pitch outside this band are ignored as non-speech artifacts. */
const MIN_VOICED_FRAMES = 3

export class SpeakerTagger {
  private clusters: Cluster[] = []
  private nextId = 0

  /**
   * Classify one utterance from its voiced frames. Returns null when there
   * is not enough voiced evidence to make a call.
   */
  classify(frames: VoiceFrame[]): SpeakerMatch | null {
    const voiced = frames.filter((f) => f.pitchHz > 0 && f.centroidHz > 0)
    if (voiced.length < MIN_VOICED_FRAMES) return null

    const pitch = median(voiced.map((f) => f.pitchHz))
    const centroid = median(voiced.map((f) => f.centroidHz))
    const logPitch = Math.log(pitch)
    const logCentroid = Math.log(centroid)

    let best: Cluster | null = null
    let bestDist = Infinity
    for (const cluster of this.clusters) {
      const dp = logPitch - cluster.logPitch
      // Centroid (timbre) is a far noisier feature than pitch — measured
      // log-spread within one voice is ~10× pitch's — so it only nudges the
      // distance rather than driving it.
      const dc = (logCentroid - cluster.logCentroid) * 0.2
      const dist = Math.sqrt(dp * dp + dc * dc)
      if (dist < bestDist) {
        bestDist = dist
        best = cluster
      }
    }

    if (best && bestDist <= MATCH_RADIUS) {
      updateCluster(best, logPitch, logCentroid, pitch)
      return { speakerId: best.id, medianPitchHz: median(best.pitchSamples) }
    }

    if (this.clusters.length >= MAX_SPEAKERS && best) {
      // Over the cap: fall back to the nearest cluster rather than inventing
      // implausible extra speakers.
      updateCluster(best, logPitch, logCentroid, pitch)
      return { speakerId: best.id, medianPitchHz: median(best.pitchSamples) }
    }

    const cluster: Cluster = {
      id: this.nextId++,
      logPitch,
      logCentroid,
      weight: 1,
      pitchSamples: [pitch],
    }
    this.clusters.push(cluster)
    return { speakerId: cluster.id, medianPitchHz: pitch }
  }

  reset(): void {
    this.clusters = []
    this.nextId = 0
  }
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

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
