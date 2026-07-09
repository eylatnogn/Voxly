import { useVoxlyStore } from '../store'

export function PowerBadge() {
  const power = useVoxlyStore((s) => s.power)
  const setPower = useVoxlyStore((s) => s.setPower)

  const saverActive = power.profile === 'saver' || power.autoSaver
  const batteryText =
    power.batteryLevel !== null
      ? `${Math.round(power.batteryLevel * 100)}%${power.charging ? ' ⚡' : ''}`
      : null

  return (
    <div className="power-badge">
      {batteryText && <span className="battery-level">{batteryText}</span>}
      <button
        className={`btn-toggle${saverActive ? ' btn-toggle-on' : ''}`}
        onClick={() =>
          setPower({ profile: power.profile === 'saver' ? 'balanced' : 'saver' })
        }
        title={
          power.autoSaver
            ? 'Battery saver engaged automatically (battery low)'
            : 'Battery saver: lower analysis rate, meter off, slower re-analysis'
        }
      >
        🔋 Saver {saverActive ? 'on' : 'off'}
      </button>
    </div>
  )
}
