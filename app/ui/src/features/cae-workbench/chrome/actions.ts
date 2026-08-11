import type { ReactNode } from 'react'

export type WorkbenchAction = Readonly<{
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
}>

export type WorkbenchMenuNode =
  | Readonly<{ type: 'action'; action: WorkbenchAction }>
  | Readonly<{ type: 'submenu'; id: string; label: string; items: readonly WorkbenchMenuNode[] }>
  | Readonly<{ type: 'separator'; id: string }>

export type WorkbenchMenuDefinition = Readonly<{
  id: string
  label: string
  items: readonly WorkbenchMenuNode[]
}>
