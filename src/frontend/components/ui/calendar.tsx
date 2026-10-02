'use client'

import { cx } from '@/lib/primitive'
import { cn } from 'cn'
import { Button } from 'react-aria-components/Button'
import type {
  CalendarCellProps,
  CalendarProps as CalendarPrimitiveProps,
  DateValue,
  HeadingProps,
} from 'react-aria-components/Calendar'
import {
  CalendarCell as CalendarCellPrimitive,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarGrid as CalendarGridPrimitive,
  CalendarHeaderCell as CalendarHeaderCellPrimitive,
  Calendar as CalendarPrimitive
} from 'react-aria-components/Calendar'
import { Heading } from 'react-aria-components/Heading'

/**
 * Intent UI calendar — a React Aria date picker surface used by the manager
 * overview to pick the reporting date/week. Values flow through RAC state so
 * the parent owns the selected date.
 */

const Calendar = ({ className, ...props }: CalendarPrimitiveProps<DateValue>) => (
  <CalendarPrimitive
    data-slot="calendar"
    className={cx(
      'rounded-lg border bg-bg p-3 text-sm/6 dark:bg-muted',
      className
    )}
    {...props}
  />
)

const CalendarHeader = ({ className, ...props }: React.ComponentProps<'header'>) => (
  <header
    data-slot="calendar-header"
    className={cn('flex items-center justify-between gap-2 px-1 pb-2', className)}
    {...props}
  />
)

const CalendarTitle = ({ className, ...props }: HeadingProps) => (
  <Heading
    data-slot="calendar-title"
    className={cn('flex-1 text-center font-semibold text-sm', className)}
    {...props}
  />
)

const CalendarNavButton = ({ className, ...props }: React.ComponentProps<typeof Button>) => (
  <Button
    data-slot="calendar-nav-button"
    className={cx(
      'grid size-8 shrink-0 place-content-center rounded-md outline-hidden text-fg transition',
      'hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring pressed:bg-secondary-fg/10',
      className
    )}
    {...props}
  />
)

const CalendarGrid = ({ className, ...props }: React.ComponentProps<typeof CalendarGridPrimitive>) => (
  <CalendarGridPrimitive
    data-slot="calendar-grid"
    className={cn('border-collapse', className)}
    {...props}
  />
)

const CalendarWeekdayHeader = ({ className, ...props }: React.ComponentProps<'th'>) => (
  <CalendarHeaderCellPrimitive
    data-slot="calendar-weekday-header"
    className={cn('w-9 pb-1 font-normal text-muted-fg text-xs', className)}
    {...props}
  />
)

const CalendarCell = ({ className, ...props }: CalendarCellProps) => (
  <CalendarCellPrimitive
    data-slot="calendar-day"
    className={cx(
      'group flex size-9 cursor-default items-center justify-center rounded-md p-0.5 text-center align-middle text-fg outline-hidden transition',
      'hover:bg-secondary pressed:bg-secondary-fg/10',
      'focus-visible:ring-2 focus-visible:ring-ring',
      'selected:bg-primary selected:font-semibold selected:text-primary-fg selected:hover:bg-primary',
      // Today (when not selected): blue ring on the unfilled cell, so moving
      // the selection elsewhere keeps the current day findable. The arbitrary
      // `data-[today]` variant reads React Aria's own attribute, so it needs
      // no plugin support.
      'data-[today]:border-2 data-[today]:border-primary',
      'outside-month:text-muted-fg/60 unavailable:text-muted-fg/40 unavailable:line-through',
      className
    )}
    {...props}
  />
)

export {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeader,
  CalendarNavButton,
  CalendarTitle,
  CalendarWeekdayHeader
}
export type { DateValue }

