import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface MenuItem {
  /** A horizontal rule instead of an item. Every other field is ignored. */
  separator?: boolean
  label?: string
  icon?: LucideIcon
  onSelect?: () => void
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  shortcut?: string
}

interface DropdownProps {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  ariaLabel?: string
  className?: string
  menuClassName?: string
}

const GAP = 6
const ITEM_HEIGHT = 34
const MENU_PADDING = 12

interface MenuPosition {
  top: number
  left?: number
  right?: number
  maxHeight: number
}

/**
 * The menu renders in a portal with fixed positioning. Anchoring it inside the
 * trigger instead would let scroll containers clip it — the conversation list is
 * `overflow-y: auto`, so its menus were cut off at the edge of the list.
 */
export function Dropdown({ trigger, items, align = 'right', ariaLabel, className, menuClassName }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const measure = useCallback(() => {
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const estimatedHeight = items.length * ITEM_HEIGHT + MENU_PADDING
    const spaceBelow = window.innerHeight - rect.bottom - GAP - 8
    const spaceAbove = rect.top - GAP - 8
    // Flip above the trigger when there is not enough room below
    const placeAbove = spaceBelow < Math.min(estimatedHeight, 200) && spaceAbove > spaceBelow

    setPosition({
      top: placeAbove ? Math.max(8, rect.top - GAP - Math.min(estimatedHeight, spaceAbove)) : rect.bottom + GAP,
      ...(align === 'right'
        ? { right: Math.max(8, window.innerWidth - rect.right) }
        : { left: Math.max(8, rect.left) }),
      maxHeight: Math.max(120, placeAbove ? spaceAbove : spaceBelow),
    })
  }, [align, items.length])

  useEffect(() => {
    if (!open) return
    measure()

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    // `true` catches scrolling inside the sidebar list, not just the window
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const focusables = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    if (focusables.length === 0) return
    const index = focusables.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? (index + 1) % focusables.length
        : (index - 1 + focusables.length) % focusables.length
    focusables[next]?.focus()
  }

  const toggle = () => {
    // Measure before opening so the menu never paints at stale coordinates
    if (!open) measure()
    setOpen((o) => !o)
  }

  return (
    <div ref={rootRef} className={cn('dropdown', className)}>
      {trigger({ open, toggle, ref: buttonRef })}
      {createPortal(
        <AnimatePresence>
          {open && position && (
            <motion.div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              className={cn('menu', menuClassName)}
              style={{
                top: position.top,
                left: position.left,
                right: position.right,
                maxHeight: position.maxHeight,
              }}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              onKeyDown={onMenuKeyDown}
            >
              {items.map((item, i) => {
                /*
                 * A separator is not focusable and carries no label: it groups
                 * the list visually without adding a stop to keyboard
                 * navigation, which is what `role="separator"` means here.
                 */
                if (item.separator) return <div key={i} role="separator" className="menu-separator" />
                const Icon = item.icon
                return (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={cn('menu-item', item.danger && 'menu-item-danger', item.checked && 'menu-item-checked')}
                    onClick={() => {
                      if (item.disabled) return
                      setOpen(false)
                      item.onSelect?.()
                    }}
                    onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).focus()}
                  >
                    <span className="menu-item-icon">{Icon ? <Icon size={16} /> : null}</span>
                    <span className="menu-item-label">{item.label}</span>
                    {item.shortcut ? <span className="menu-item-shortcut">{item.shortcut}</span> : null}
                    {item.checked ? <Check size={15} className="menu-item-check" aria-hidden="true" /> : null}
                  </button>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
