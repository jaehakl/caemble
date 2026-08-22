import {
  Archive,
  CopyPlus,
  ExternalLink,
  GitFork,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { GeometryManagerFilters } from './GeometryManagerFilters'
import type { GeometryManagerRibbonAction, GeometryManagerRibbonState } from './geometryManagerTypes'

function actionLabel(action: GeometryManagerRibbonAction) {
  return action.disabled && action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label
}

function RibbonButton({ action, icon }: { action: GeometryManagerRibbonAction; icon: ReactNode }) {
  return (
    <Button
      aria-label={actionLabel(action)}
      disabled={action.disabled}
      onClick={action.onSelect}
      size="sm"
      title={action.disabledReason}
      type="button"
      variant={action.destructive ? 'destructive' : 'ghost'}
    >
      {icon}
      {action.label}
    </Button>
  )
}

export function GeometryManagerRibbon({
  state,
  extraActions,
}: {
  state: GeometryManagerRibbonState | null
  extraActions?: ReactNode
}) {
  if (!state) {
    return (
      <div className="flex min-h-12 items-center gap-3">
        <div className="flex min-w-48 flex-col justify-center border-r pr-3">
          <span className="text-sm font-semibold">Geometry Manager</span>
          <span className="mt-1 text-xs text-muted-foreground">선택 상태를 불러오는 중입니다.</span>
        </div>
      </div>
    )
  }

  const actions = state.actions
  const selectedActions = [
    { action: actions.forkExample, icon: <GitFork /> },
    { action: actions.editVersion, icon: <CopyPlus /> },
    { action: actions.useInExperiment, icon: <ExternalLink /> },
    { action: actions.publishDraft, icon: <Upload /> },
    { action: actions.discardDraft, icon: <Undo2 /> },
    { action: actions.archiveVersion, icon: <Archive /> },
    { action: actions.deleteVersion, icon: <Trash2 /> },
    { action: actions.deletePackage, icon: <Trash2 /> },
  ]

  return (
    <div className="grid gap-2">
      <div className="flex min-h-12 min-w-max items-center gap-2">
        <div className="flex min-w-48 flex-col justify-center border-r pr-3">
          <span className="text-sm font-semibold">Geometry Manager</span>
          <span className="mt-1 max-w-56 truncate text-xs text-muted-foreground" title={state.selectionLabel}>
            {state.selectionLabel}
          </span>
        </div>
        <RibbonButton action={actions.newGeometry} icon={<CopyPlus />} />
        <RibbonButton action={actions.refresh} icon={<RefreshCw />} />
        <RibbonButton action={actions.resetFilters} icon={<RotateCcw />} />
        <RibbonButton action={actions.workspaceSettings} icon={<Settings2 />} />
        {selectedActions.map(({ action, icon }) => (
          <RibbonButton action={action} icon={icon} key={action.label} />
        ))}
        {extraActions}
      </div>
      <GeometryManagerFilters
        archive={state.filters.archive}
        authenticated={state.authenticated}
        isAdmin={state.isAdmin}
        namespace={state.filters.namespace}
        namespaces={state.namespaces}
        onArchiveChange={state.filterActions.archive}
        onNamespaceChange={state.filterActions.namespace}
        onOpenRepositoryManager={actions.repositoryManager.onSelect}
        onOwnerChange={state.filterActions.owner}
        onRepositoryChange={state.filterActions.repository}
        onReset={state.filterActions.reset}
        onSearchChange={state.filterActions.search}
        owner={state.filters.owner}
        owners={state.owners}
        repository={state.filters.repository}
        repositoryOptions={state.repositoryOptions}
        search={state.filters.search}
      />
    </div>
  )
}
