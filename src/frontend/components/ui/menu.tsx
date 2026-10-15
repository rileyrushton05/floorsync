'use client'

import { CheckIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { composeRenderProps } from 'react-aria-components/composeRenderProps'
import { Header } from 'react-aria-components/Header'
import {
  Collection,
  Menu as MenuPrimitive,
  MenuItem as MenuItemPrimitive,
  type MenuItemProps as MenuItemPrimitiveProps,
  type MenuProps,
  MenuSection as MenuSectionPrimitive,
  type MenuSectionProps as MenuSectionPrimitiveProps,
  MenuTrigger as MenuTriggerPrimitive,
  SubmenuTrigger as SubmenuTriggerPrimitive,
} from 'react-aria-components/Menu'
import { twJoin } from 'cn'
import { cx } from '@/lib/primitive'
import {
  DropdownDescription,
  DropdownLabel,
  DropdownSeparator,
  dropdownItemStyles,
  dropdownSectionStyles,
} from './dropdown'
import { PopoverContent, type PopoverContentProps } from './popover'

const Menu = MenuTriggerPrimitive
const MenuSubmenu = SubmenuTriggerPrimitive

interface MenuContentProps<T> extends MenuProps<T> {
  placement?: PopoverContentProps['placement']
  popover?: Omit<PopoverContentProps, 'children'>
}

const MenuContent = <T extends object>({ className, placement, popover, ...props }: MenuContentProps<T>) => {
  return (
    <PopoverContent placement={placement} {...popover} className={cx('min-w-48', popover?.className)}>
      <MenuPrimitive
        className={cx(
          'grid max-h-[inherit] grid-cols-[auto_1fr] overflow-auto overscroll-contain p-1 outline-hidden [clip-path:inset(0_0_0_0_round_calc(var(--radius-lg)-2px))] *:[[role=group]+[role=group]]:mt-1 *:[[role=group]+[role=separator]]:mt-1',
          className
        )}
        {...props}
      />
    </PopoverContent>
  )
}

interface MenuItemProps extends MenuItemPrimitiveProps {
  intent?: 'danger' | 'warning'
}

const MenuItem = ({ className, intent, children, ...props }: MenuItemProps) => {
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined)
  return (
    <MenuItemPrimitive
      textValue={textValue}
      className={composeRenderProps(className, (className, { hasSubmenu, isOpen, ...renderProps }) =>
        dropdownItemStyles({
          ...renderProps,
          intent,
          className: twJoin(hasSubmenu && isOpen && 'bg-accent text-accent-fg', className),
        })
      )}
      {...props}
    >
      {(values) => (
        <>
          {values.isSelected && values.selectionMode !== 'none' && (
            <CheckIcon data-slot="check-indicator" className="-ms-0.5 me-1.5 h-lh w-4 shrink-0" />
          )}
          {typeof children === 'function' ? (
            children(values)
          ) : typeof children === 'string' ? (
            <DropdownLabel>{children}</DropdownLabel>
          ) : (
            children
          )}
          {values.hasSubmenu && (
            <ChevronRightIcon data-slot="chevron" className="absolute inset-e-2 top-1/2 size-4 -translate-y-1/2" />
          )}
        </>
      )}
    </MenuItemPrimitive>
  )
}

interface MenuSectionProps<T> extends MenuSectionPrimitiveProps<T> {
  title?: string
}

const MenuSection = <T extends object>({ className, title, children, ...props }: MenuSectionProps<T>) => {
  const { section, header } = dropdownSectionStyles()
  return (
    <MenuSectionPrimitive className={section({ className })} {...props}>
      {title && <Header className={header()}>{title}</Header>}
      <Collection items={props.items}>{children}</Collection>
    </MenuSectionPrimitive>
  )
}

const MenuLabel = DropdownLabel
const MenuDescription = DropdownDescription
const MenuSeparator = DropdownSeparator

export type { MenuContentProps, MenuItemProps, MenuSectionProps }
export {
  Menu,
  MenuContent,
  MenuDescription,
  MenuItem,
  MenuLabel,
  MenuSection,
  MenuSeparator,
  MenuSubmenu,
}
