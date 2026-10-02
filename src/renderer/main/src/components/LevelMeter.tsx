interface Props {
  label: string
  level: number
  active: boolean
  color: string
}

/** RMS level shown on a perceptual (dB) scale from -60 dB to 0 dB. */
export function LevelMeter({ label, level, active, color }: Props) {
  const db = level > 0 ? 20 * Math.log10(level) : -60
  const pct = active ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full transition-[width] duration-100 ease-out" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted tabular-nums">
        {active && level > 0 ? `${Math.round(db)} dB` : '—'}
      </span>
    </div>
  )
}
