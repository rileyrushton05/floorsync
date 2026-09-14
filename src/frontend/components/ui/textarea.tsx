'use client'

import { cx } from '@/lib/primitive'
import {
  TextArea as TextAreaPrimitive,
  type TextAreaProps,
} from 'react-aria-components/TextArea'

export function TextArea({ className, ...props }: TextAreaProps) {
  return (
    <span data-slot="control" className="relative block w-full">
      <TextAreaPrimitive
        className={cx(
          'relative block w-full appearance-none rounded-lg bg-(--control-bg,transparent) px-[calc(--spacing(3.5)-1px)] py-[calc(--spacing(2.5)-1px)] sm:px-[calc(--spacing(3)-1px)] sm:py-[calc(--spacing(1.5)-1px)]',
          'text-base/6 text-fg placeholder:text-muted-fg sm:text-sm/6',
          'border border-input enabled:hover:border-muted-fg/30',
          'outline-hidden focus:border-ring/70 focus:ring-3 focus:ring-ring/20 focus:enabled:hover:border-ring/80',
          'disabled:bg-muted forced-colors:in-disabled:text-[GrayText]',
          'dark:scheme-dark',
          className
        )}
        {...props}
      />
    </span>
  )
}
