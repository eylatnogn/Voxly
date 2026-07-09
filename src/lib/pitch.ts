/**
 * Lightweight voice-feature extraction used for speaker tagging.
 *
 * Runs on short PCM frames at a low duty cycle (a few frames per second),
 * which keeps CPU wake-ups — and therefore battery drain — minimal. A frame
 * below the energy gate is rejected before any O(n²) work happens.
 */

export interface VoiceFrame {
  /** Fundamental frequency in Hz, or 0 if the frame is unvoiced. */
  pitchHz: number
  /** Spectral centroid in Hz — a cheap proxy for voice brightness/timbre. */
  centroidHz: number
  /** RMS energy of the frame (0..1). */
  energy: number
  /** Seconds since session start. */
  time: number
}

const MIN_PITCH_HZ = 60
const MAX_PITCH_HZ = 400
/** Default RMS gate; pass a lower gate for far-field (distant mic) capture. */
export const DEFAULT_ENERGY_GATE = 0.008
export const FAR_FIELD_ENERGY_GATE = 0.003
/** Normalized autocorrelation must clear this for the frame to count as voiced. */
const VOICING_THRESHOLD = 0.45

/**
 * Autocorrelation pitch detector with parabolic interpolation.
 * Frames are ~2048 samples, so the tau search space is small enough that the
 * quadratic scan stays cheap at our low analysis rate.
 */
export function analyzeFrame(
  samples: Float32Array,
  sampleRate: number,
  time: number,
  energyGate: number = DEFAULT_ENERGY_GATE,
): VoiceFrame | null {
  const n = samples.length
  let sumSquares = 0
  for (let i = 0; i < n; i++) sumSquares += samples[i] * samples[i]
  const energy = Math.sqrt(sumSquares / n)
  if (energy < energyGate) return null

  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ)
  const maxLag = Math.min(Math.floor(sampleRate / MIN_PITCH_HZ), n - 1)

  let bestLag = -1
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < n - lag; i++) corr += samples[i] * samples[i + lag]
    corr /= sumSquares
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }

  let pitchHz = 0
  if (bestLag > 0 && bestCorr >= VOICING_THRESHOLD) {
    // Parabolic interpolation around the peak for sub-sample lag precision.
    const refined = refineLag(samples, sumSquares, bestLag, minLag, maxLag)
    pitchHz = sampleRate / refined
  }

  return { pitchHz, centroidHz: spectralCentroid(samples, sampleRate), energy, time }
}

function refineLag(
  samples: Float32Array,
  sumSquares: number,
  lag: number,
  minLag: number,
  maxLag: number,
): number {
  const corrAt = (l: number) => {
    let c = 0
    for (let i = 0; i < samples.length - l; i++) c += samples[i] * samples[i + l]
    return c / sumSquares
  }
  if (lag <= minLag || lag >= maxLag) return lag
  const y0 = corrAt(lag - 1)
  const y1 = corrAt(lag)
  const y2 = corrAt(lag + 1)
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < 1e-9) return lag
  const delta = (0.5 * (y0 - y2)) / denom
  return lag + Math.max(-1, Math.min(1, delta))
}

/**
 * Spectral centroid via Goertzel-style band sampling instead of a full FFT:
 * we only probe 32 log-spaced bands, which is plenty for a timbre feature and
 * far cheaper than a 2048-point transform.
 */
function spectralCentroid(samples: Float32Array, sampleRate: number): number {
  const BANDS = 32
  const minHz = 100
  const maxHz = 4000
  let weighted = 0
  let total = 0
  for (let b = 0; b < BANDS; b++) {
    const hz = minHz * Math.pow(maxHz / minHz, b / (BANDS - 1))
    const power = goertzelPower(samples, sampleRate, hz)
    weighted += power * hz
    total += power
  }
  return total > 0 ? weighted / total : 0
}

function goertzelPower(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const omega = (2 * Math.PI * freqHz) / sampleRate
  const coeff = 2 * Math.cos(omega)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}
