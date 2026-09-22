import type { ReactNode } from 'react'
import type { WorkbenchSectionId } from '../types'

export type WorkbenchAction = Readonly<{
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  primary?: boolean
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
  { id: 'experiment', label: '구성' },
  { id: 'measurement', label: '실행' },
  { id: 'calculation', label: '가공' },
  { id: 'analysis', label: '통계' },
  { id: 'prediction', label: '예측' },
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
