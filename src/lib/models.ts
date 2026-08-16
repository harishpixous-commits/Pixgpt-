import { Cpu, Sparkles, Eye } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ModelId } from './types'

export interface ModelInfo {
  label: string
  blurb: string
  icon: LucideIcon
}

export const MODELS: Record<ModelId, ModelInfo> = {
  'pixgpt-fast': {
    label: 'PixGPT Fast',
    blurb: 'Quick responses for everyday tasks',
    icon: Cpu,
  },
  'pixgpt-pro': {
    label: 'PixGPT Pro',
    blurb: 'Deep reasoning for complex work',
    icon: Sparkles,
  },
  'pixgpt-vision': {
    label: 'PixGPT Vision',
    blurb: 'Understands images and documents',
    icon: Eye,
  },
}

export const MODEL_IDS = Object.keys(MODELS) as ModelId[]
