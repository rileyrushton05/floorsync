'use client'

import { Toaster as ToasterPrimitive, type ToasterProps } from 'sonner'
import { twJoin } from 'cn'
import { useTheme } from '@/components/theme-provider'

export function Toast(props: ToasterProps) {
  const { theme = 'system' } = useTheme()
  return (
    <ToasterPrimitive
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      richColors
      closeButton
      toastOptions={{
        className: twJoin(
          'not-has-data-[slot=note]:backdrop-blur-3xl will-change-transform *:data-[slot=note]:relative *:data-[slot=note]:z-50 *:data-icon:mt-0.5 *:data-icon:self-start has-data-description:*:data-icon:mt-1',
          '**:data-action:[--normal-bg:var(--color-primary-fg)] **:data-action:[--normal-text:var(--color-primary)]',
          // The close button is absolutely positioned, so it does not reserve
          // its own space and a long message would otherwise run underneath it.
          // Sonner's own 16px padding wins on specificity, hence the `!`.
          'pe-11!'
        ),
        classNames: {
          // Sonner paints the close button from `--normal-bg` / `--normal-text`
          // whatever the toast's type, which here means a white disc: invisible
          // on a plain toast and detached from a success/danger one. Inheriting
          // `currentColor` instead makes one rule work on all five types. Its
          // own hover is dead too — sonner reaches for `--gray2` / `--gray5`,
          // which this theme never defines — so that is restated as well.
          //
          // `!` throughout because sonner's own rule is three attribute
          // selectors deep and would otherwise win.
          closeButton: twJoin(
            'border-current/30! bg-current/10! text-current!',
            'transition hover:border-current/50! hover:bg-current/20!',
            // Sonner hardcodes `top: 0` — only the inline axis is exposed as a
            // custom property — so centring vertically has to be done here.
            'top-1/2!',
            // A 20px disc holding a 12px glyph whose stroke is 1.5 against a
            // 24 viewBox renders the X at well under a pixel, which is what
            // made it easy to miss. Widen the target and let the glyph grow
            // and thicken with it.
            'size-6!',
            '[&>svg]:size-3.5 [&>svg]:[stroke-width:2.5]'
          ),
        },
      }}
      style={
        {
          // Park the close button centred on the trailing edge, inset rather
          // than overhanging: sonner's default hangs it off the top-left
          // corner, which points back into the page for a top-right toast.
          '--toast-close-button-start': 'unset',
          '--toast-close-button-end': '12px',
          '--toast-close-button-transform': 'translateY(-50%)',

          '--normal-bg': 'var(--color-overlay)',
          '--normal-text': 'var(--color-overlay-fg)',
          '--normal-border': 'var(--color-border)',

          '--success-bg': 'var(--color-success-subtle)',
          '--success-border': 'color-mix(in oklab, var(--success-subtle-fg) 20%, transparent)',
          '--success-text': 'var(--color-success-subtle-fg)',

          '--error-bg': 'var(--color-danger-subtle)',
          '--error-border': 'color-mix(in oklab, var(--danger-subtle-fg) 20%, transparent)',
          '--error-text': 'var(--color-danger-subtle-fg)',

          '--warning-bg': 'var(--color-warning-subtle)',
          '--warning-border': 'color-mix(in oklab, var(--warning-subtle-fg) 20%, transparent)',
          '--warning-text': 'var(--color-warning-subtle-fg)',

          '--info-bg': 'var(--color-info-subtle)',
          '--info-border': 'color-mix(in oklab, var(--info-subtle-fg) 20%, transparent)',
          '--info-text': 'var(--color-info-subtle-fg)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}
