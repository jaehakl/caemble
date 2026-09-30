import { useState } from 'react'
import { LoaderCircle, Plus, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { useAuth } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { Optimization } from '@/contracts/api/optimization'
import { OptimizationSetup } from './OptimizationSetup'
import { OptimizationManagement } from './OptimizationManagement'
import { createOptimizationDraft, type OptimizationDraft } from './optimizationDraft'
import { useOptimizationCreation } from './useOptimizationData'
import { optimizationVariables } from './variables'

export function OptimizationWorkspace({
  workbench,
  requestedOptimizationId,
  onSelectOptimization,
  onApplyBest,
  onRequestLogin,
}: {
  workbench: CaeWorkbenchState
  requestedOptimizationId?: string | null
  onSelectOptimization: (id: string | null) => void
  onApplyBest: (optimization: Optimization) => void
  onRequestLogin: () => void
}) {
  const auth = useAuth()
  if (!auth.isAuthenticated)
    return (
      <WorkbenchSignInPrompt
        description="최적화를 시작하고 저장된 실행을 확인하려면 로그인하세요."
        onSignIn={onRequestLogin}
      />
    )
  const schema = workbench.experimentDocument.varsSchema
  const variables = workbench.candidateVars ?? workbench.experimentDocument.variables
  let preparationMessage: string | null = workbench.selectionRestoring
    ? 'Candidate를 복원하는 중입니다. 진행 중인 최적화는 계속 확인할 수 있습니다.'
    : workbench.experimentId === null || !schema || !variables
      ? 'Experiment를 저장하고 Candidate를 준비하면 새 Optimization을 시작할 수 있습니다.'
      : null
  if (!preparationMessage && schema && variables) {
    try {
      optimizationVariables(variables, schema)
    } catch {
      preparationMessage = 'Candidate의 변수와 현재 소스가 일치하지 않습니다. 시뮬레이션에서 Candidate를 재생성하세요.'
    }
  }
  const sourceKey = JSON.stringify(workbench.experiment?.sourceBundle ?? workbench.experimentRecord?.source_hash)
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg border bg-muted/40 p-2 text-primary">
            <SlidersHorizontal className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold">최적화</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              진행 상태와 최선 후보를 확인하고, 다음 탐색을 시작하세요.
            </p>
          </div>
        </div>
        <OptimizationCreationPanel
          key={`${auth.queryScope}:${workbench.experimentId}:${workbench.workspaceSession}:${sourceKey}`}
          workbench={workbench}
          preparationMessage={preparationMessage}
          onCreated={(optimization) => {
            onSelectOptimization(optimization.id)
            toast.success('최적화를 시작했습니다.')
          }}
        />
      </header>
      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:p-5">
        {preparationMessage ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border bg-background p-3 text-xs leading-relaxed text-muted-foreground"
          >
            {workbench.selectionRestoring ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : null}
            {preparationMessage}
          </p>
        ) : null}
        <OptimizationManagement
          experimentId={workbench.experimentId ?? undefined}
          selectedId={requestedOptimizationId}
          onSelect={onSelectOptimization}
          onApplyBest={onApplyBest}
        />
      </main>
    </div>
  )
}

function OptimizationCreationPanel({
  workbench,
  preparationMessage,
  onCreated,
}: {
  workbench: CaeWorkbenchState
  preparationMessage: string | null
  onCreated: (optimization: Optimization) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<OptimizationDraft | null>(null)
  const creation = useOptimizationCreation((optimization) => {
    setOpen(false)
    setDraft(null)
    onCreated(optimization)
  })
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next && !draft && !preparationMessage) setDraft(createOptimizationDraft(workbench))
        setOpen(next)
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" disabled={preparationMessage !== null} title={preparationMessage ?? undefined}>
          <Plus className="size-4" />새 Optimization
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full max-w-none gap-0 p-0 sm:w-[36rem] sm:max-w-[90vw]">
        <SheetHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <SheetTitle>새 Optimization</SheetTitle>
          <SheetDescription className="truncate text-xs">
            {workbench.experimentName} · 현재 Candidate에서 시작
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {preparationMessage ? (
            <p role="status" className="p-5 text-sm text-muted-foreground">
              {preparationMessage}
            </p>
          ) : draft ? (
            <OptimizationSetup workbench={workbench} draft={draft} onDraftChange={setDraft} creation={creation} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
