import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface TooltipProps {
  label: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}

export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  return (
    <span className={cn('tooltip-wrap', className)}>
      {children}
      <span role="tooltip" className={cn('tooltip', `tooltip-${side}`)}>
        {label}
      </span>
    </span>
  )
}
