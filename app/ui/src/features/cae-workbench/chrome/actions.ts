import type { ReactNode } from 'react'
import type { WorkbenchSectionId } from '../types'

export type WorkbenchAction = Readonly<{
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  pressed?: boolean
  onSelect: () => void
}>

export type WorkbenchSectionDefinition = Readonly<{
  id: WorkbenchSectionId
  label: string
  disabled?: boolean
  disabledReason?: string
}>

export const defaultWorkbenchSections: readonly WorkbenchSectionDefinition[] = Object.freeze([
  { id: 'experiment', label: 'Experiment' },
  { id: 'measurement', label: 'Calculation' },
  { id: 'prediction', label: 'Prediction' },
  { id: 'material', label: 'Material' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'admin', label: 'Admin' },
  { id: 'lab', label: 'Lab' },
  { id: 'help', label: 'Help' },
  { id: 'setting', label: 'Setting' },
])

export type WorkbenchMenuNode =
  | Readonly<{ type: 'action'; action: WorkbenchAction }>
  | Readonly<{ type: 'submenu'; id: string; label: string; items: readonly WorkbenchMenuNode[] }>
  | Readonly<{ type: 'separator'; id: string }>

export type WorkbenchMenuDefinition = Readonly<{
  id: string
  label: string
  items: readonly WorkbenchMenuNode[]
}>
