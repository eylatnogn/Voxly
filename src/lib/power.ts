import { useVoxlyStore } from '../store'
import type { PowerProfile } from '../types'

/**
 * Battery-aware duty-cycle policy. Everything that costs power in Voxly asks
 * this module how hard it is allowed to work:
 *
 *  - voice-feature analysis rate (frames per second of pitch analysis)
 *  - whether the level meter animates
 *  - debounce window for the edit analyzer
 *
 * When the Battery Status API reports discharging below the threshold, or the
 * user picks the saver profile, everything steps down together.
 */

const SAVER_BATTERY_THRESHOLD = 0.25

interface DutyCycle {
  /** Voice-analysis frames per second while someone is speaking. */
  analysisFps: number
  /** Level-meter refresh interval in ms (0 = meter disabled). */
  meterIntervalMs: number
  /** Debounce before re-running the edit analyzer, ms. */
  analyzeDebounceMs: number
}

const PROFILES: Record<PowerProfile, DutyCycle> = {
  balanced: { analysisFps: 4, meterIntervalMs: 120, analyzeDebounceMs: 1200 },
  saver: { analysisFps: 2, meterIntervalMs: 0, analyzeDebounceMs: 3000 },
}

export function currentDutyCycle(): DutyCycle {
  const { power } = useVoxlyStore.getState()
  const effective: PowerProfile =
    power.profile === 'saver' || power.autoSaver ? 'saver' : 'balanced'
  return PROFILES[effective]
}

interface BatteryManagerLike extends EventTarget {
  level: number
  charging: boolean
}

/** Wire up Battery Status API monitoring (no-op where unsupported). */
export async function initPowerMonitor(): Promise<void> {
  const nav = navigator as Navigator & {
    getBattery?: () => Promise<BatteryManagerLike>
  }
  if (!nav.getBattery) return
  try {
    const battery = await nav.getBattery()
    const update = () => {
      useVoxlyStore.getState().setPower({
        batteryLevel: battery.level,
        charging: battery.charging,
        autoSaver: !battery.charging && battery.level <= SAVER_BATTERY_THRESHOLD,
      })
    }
    battery.addEventListener('levelchange', update)
    battery.addEventListener('chargingchange', update)
    update()
  } catch {
    // Battery API unavailable (permission policy, etc.) — stay in balanced mode.
  }
}

/**
 * Run a callback during browser idle time so analysis never competes with
 * user interaction or forces extra CPU wake-ups.
 */
export function runWhenIdle(fn: () => void): void {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => fn(), { timeout: 4000 })
  } else {
    setTimeout(fn, 250)
  }
}
