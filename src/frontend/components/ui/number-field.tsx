'use client'

import { MinusIcon, PlusIcon } from '@heroicons/react/20/solid'
import { Button, type ButtonProps } from 'react-aria-components/Button'
import type { InputProps as PrimitiveInputProps } from 'react-aria-components/Input'
import {
  NumberField as NumberFieldPrimitive,
  type NumberFieldProps,
} from 'react-aria-components/NumberField'
import { Input, InputGroup } from '@/components/ui/input'
import { cx } from '@/lib/primitive'
import { fieldStyles } from './field'

const NumberField = ({ className, ...props }: NumberFieldProps) => {
  return (
    <NumberFieldPrimitive {...props} data-slot="control" className={cx(fieldStyles(), className)} />
  )
}

interface InputProps extends PrimitiveInputProps {
  ref?: React.RefObject<HTMLInputElement>
  /**
   * Show the increment/decrement buttons. Default on.
   *
   * Turn them off where the value is typed rather than nudged — a route's
   * duration in minutes or its energy are read off a spec sheet, not dialled
   * in one unit at a time, and a stepper there is a tall target that mostly
   * gets in the way of the number beside it.
   */
  steppers?: boolean
  /** Unit shown inside the field, e.g. `min` or `kWh`. Decoration, not a value. */
  suffix?: string
}

function NumberInput({ className, steppers = true, suffix, ...props }: InputProps) {
  // The end gutter has to clear whatever actually sits in it, or the typed
  // number slides under it: the stepper pair, a bare unit, or neither.
  const gutter = steppers
    ? '[--input-gutter-end:--spacing(20)]'
    : suffix
      ? '[--input-gutter-end:--spacing(12)]'
      : ''

  return (
    <InputGroup className={gutter}>
      <Input className={cx('tabular-nums', className)} {...props} />
      {steppers ? (
        <div
          data-slot="text"
          className="in-disabled:pointer-events-none pointer-events-auto end-0 p-px in-disabled:opacity-50"
        >
          <div className="flex h-full items-center divide-x overflow-hidden rounded-e-[calc(var(--radius-lg)-1px)] border-s">
            <StepperButton slot="decrement" />
            <StepperButton slot="increment" />
          </div>
        </div>
      ) : (
        suffix && (
          <span data-slot="text" className="text-muted-fg text-sm tabular-nums">
            {suffix}
          </span>
        )
      )}
    </InputGroup>
  )
}

interface StepperButtonProps extends ButtonProps {
  slot: 'increment' | 'decrement'
  className?: string
}

const StepperButton = ({ slot, className, ...props }: StepperButtonProps) => {
  return (
    <Button
      className={cx(
        'inline-grid place-content-center pressed:text-fg text-muted-fg enabled:hover:text-fg',
        'size-full min-w-11 grow bg-input/20 pressed:bg-input/60 sm:min-w-8.5',
        '*:data-[slot=stepper-icon]:size-5 sm:*:data-[slot=stepper-icon]:size-4',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      slot={slot}
      {...props}
    >
      {slot === 'increment' ? (
        <PlusIcon data-slot="stepper-icon" />
      ) : (
        <MinusIcon data-slot="stepper-icon" />
      )}
    </Button>
  )
}

export type { NumberFieldProps }
export { NumberField, NumberInput }
