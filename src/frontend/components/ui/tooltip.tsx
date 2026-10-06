'use client'

import { InformationCircleIcon } from '@heroicons/react/24/outline'
import { Button as ButtonPrimitive } from 'react-aria-components/Button'
import {
  Tooltip as TooltipPrimitive,
  type TooltipProps,
  TooltipTrigger,
} from 'react-aria-components/Tooltip'
import { cx } from '@/lib/primitive'

const TooltipContent = ({ className, offset = 8, ...props }: TooltipProps) => {
  return (
    <TooltipPrimitive
      offset={offset}
      className={cx(
        'max-w-xs rounded-lg bg-overlay px-3 py-2 text-overlay-fg text-sm/6 shadow-xs ring ring-muted-fg/20 drop-shadow-xl dark:ring-border',
        'entering:fade-in exiting:fade-out entering:animate-in exiting:animate-out',
        'placement-left:entering:slide-in-from-right-1 placement-right:entering:slide-in-from-left-1 placement-top:entering:slide-in-from-bottom-1 placement-bottom:entering:slide-in-from-top-1',
        'forced-colors:bg-[Canvas]',
        className
      )}
      {...props}
    />
  )
}

/** A small info icon that reveals guidance on hover or keyboard focus. */
const InfoTooltip = ({
  label,
  children,
  className,
}: {
  /** Accessible name for the icon button, e.g. "About job selection". */
  label: string
  children: React.ReactNode
  className?: string
}) => {
  return (
    <TooltipTrigger delay={300}>
      <ButtonPrimitive
        aria-label={label}
        className={cx(
          'inline-grid size-5 shrink-0 cursor-help place-content-center rounded-full text-muted-fg outline-hidden hover:text-fg focus-visible:ring-2 focus-visible:ring-ring',
          className
        )}
      >
        <InformationCircleIcon className="size-4" aria-hidden />
      </ButtonPrimitive>
      <TooltipContent>{children}</TooltipContent>
    </TooltipTrigger>
  )
}

export { InfoTooltip, TooltipContent, TooltipTrigger }
