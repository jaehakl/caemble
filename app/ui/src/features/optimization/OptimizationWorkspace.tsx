import { useState } from 'react'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { useAuth } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { OptimizationStudy } from '@/contracts/api/optimization'
import { OptimizationSetup } from './OptimizationSetup'
import { StudyManagement } from './StudyManagement'

export function OptimizationWorkspace({
  workbench,
  initialStudyId,
  onApplyBest,
  onRequestLogin,
}: {
  workbench: CaeWorkbenchState
  initialStudyId?: string | null
  onApplyBest: (study: OptimizationStudy) => void
  onRequestLogin: () => void
}) {
  const auth = useAuth()
  const [selectedId, setSelectedId] = useState<string | null>(initialStudyId ?? null)
  if (!auth.isAuthenticated)
    return (
      <WorkbenchSignInPrompt
        description="최적화를 시작하고 저장된 Study를 확인하려면 로그인하세요."
        onSignIn={onRequestLogin}
      />
    )
  const ready =
    workbench.experimentId !== null &&
    workbench.experimentDocument.varsSchema &&
    (workbench.candidateVars ?? workbench.experimentDocument.variables)
  return (
    <div className="grid h-full min-h-0 gap-4 overflow-auto p-4 lg:grid-cols-[minmax(20rem,2fr)_minmax(0,3fr)]">
      <div className="min-w-0 lg:overflow-auto lg:pr-2">
        {ready ? (
          <OptimizationSetup
            key={`${workbench.workspaceSession}:${workbench.experimentRecord?.source_hash}`}
            workbench={workbench}
            onCreated={(study) => setSelectedId(study.id)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Experiment를 저장하고 Candidate를 준비하면 최적화를 설정할 수 있습니다.
          </p>
        )}
      </div>
      <div className="min-w-0 lg:overflow-auto">
        <StudyManagement
          key={workbench.experimentId ?? 'all'}
          experimentId={workbench.experimentId ?? undefined}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onApplyBest={onApplyBest}
        />
      </div>
    </div>
  )
}
