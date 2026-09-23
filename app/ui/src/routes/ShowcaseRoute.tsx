import { useViewerSelectionStore } from '@/features/viewer/viewer/viewerSelection'
import { useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { SavedExperimentRecord } from '@/api'
import { useAuth } from '@/features/auth/use-auth'
import { ExperimentShowcase } from '@/features/experiment/ExperimentShowcase'
import { availableExperimentsQueryOptions } from '@/features/experiment/queryOptions'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'

export function Component() {
  const auth = useAuth()
  if (auth.isPending)
    return (
      <div role="status" className="grid h-full place-items-center">
        로그인 상태를 확인하는 중…
      </div>
    )
  return <ShowcasePage key={auth.queryScope} auth={auth} />
}

function ShowcasePage({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const navigate = useNavigate()
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated)
  const selectionStore = useViewerSelectionStore(workbench.workspaceSession)
  const available = useQuery(availableExperimentsQueryOptions(auth.queryScope))
  const initialized = useRef(false)
  const { loadExperiment } = workbench
  const select = useCallback(
    (row: SavedExperimentRecord) => {
      initialized.current = true
      void loadExperiment(row).catch((cause: unknown) =>
        toast.error(cause instanceof Error ? cause.message : 'Experiment를 불러오지 못했습니다.'),
      )
    },
    [loadExperiment],
  )
  useEffect(() => {
    if (initialized.current || !available.isSuccess) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || initialized.current) return
      initialized.current = true
      const demo = available.data.demos.find((row) => row.demoDefault)
      if (demo) select(demo)
    })
    return () => {
      cancelled = true
    }
  }, [available.data, available.isSuccess, select])
  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground lg:overflow-hidden">
      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <div className="min-h-[400px] border-r lg:min-h-0">
          <ExperimentShowcase
            user={auth.user}
            selectedId={workbench.experimentId}
            onSelect={select}
            onEdit={(row) => navigate(`/workbench?experiment=${row.id}`)}
            onDeleteSelected={() => workbench.detachDeletedExperiment()}
          />
        </div>
        <section aria-label="Experiment Viewer" className="flex h-[65dvh] min-h-[360px] flex-col lg:h-auto lg:min-h-0">
          <header className="border-b px-4 py-3 font-medium">
            {workbench.experimentId ? workbench.experimentName : '3D Viewer'}
          </header>
          <div className="min-h-0 flex-1">
            {workbench.experimentId ? (
              <WorkbenchViewer
                selectionStore={selectionStore}
                initialDefaults={workbench.experimentRecord?.viewer_defaults}
                presentation={workbench.viewerPresentation}
                key={`${workbench.experimentId}:${workbench.experimentDocument.resultSessionKey ?? ''}`}
                experiment={workbench.experiment}
                experimentDocument={workbench.experimentDocument}
                autoSelectResult={Boolean(workbench.selection.measurement)}
                resultContracts={workbench.selection.resultContracts}
                visualizations={workbench.selection.visualizations}
                resultErrors={workbench.selection.resultErrors}
                resultSourceHash={workbench.selection.materialSnapshot?.sourceHash}
                resultVarsHash={workbench.selection.materialSnapshot?.varsHash}
                recordedData={workbench.selection.flatRecordedData}
                recordedRules={workbench.selection.recordedRules}
                loading={workbench.selection.loading || workbench.selectionRestoring}
                downloadProgress={workbench.selection.downloadProgress}
              />
            ) : (
              <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
                Experiment 카드를 선택하면 여기에서 확인할 수 있습니다.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
