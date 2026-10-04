import { cn } from 'cn'

/**
 * A bold item count shown inline after a heading, e.g. "Schedules (12)".
 * `label` gives screen readers and hover the meaning the bare number lacks.
 */
export function HeaderCount({
  label,
  className,
  children,
}: {
  label?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn('ms-1.5 font-bold text-muted-fg tabular-nums', className)}
    >
      ({children})
    </span>
  )
}
