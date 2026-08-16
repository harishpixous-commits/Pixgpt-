import { createContext, useContext } from 'react'

export type ToastTone = 'default' | 'success' | 'error'

export interface ToastContextValue {
  push: (toast: { title: string; description?: string; tone?: ToastTone }) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
