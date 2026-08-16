import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'icon'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('btn', `btn-${variant}`, `btn-${size}`, className)}
      {...props}
    />
  )
})

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, 'aria-label': ariaLabel, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel ?? 'icon button'}
      className={cn('icon-btn', `btn-${variant}`, `icon-btn-${size}`, className)}
      {...props}
    />
  )
})
