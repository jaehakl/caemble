import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
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
      <div role="status" className="grid h-dvh place-items-center">
        로그인 상태를 확인하는 중…
      </div>
    )
  return <ShowcasePage key={auth.queryScope} auth={auth} />
}

function ShowcasePage({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const navigate = useNavigate()
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated)
  const available = useQuery(availableExperimentsQueryOptions(auth.queryScope))
  const initialized = useRef(false)
  const [expanded, setExpanded] = useState(false)
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
    <main className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <nav aria-label="페이지 이동" className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <Link to="/">CAEMBLE</Link>
        <Link className="rounded-md border px-3 py-1 text-sm" to="/workbench">
          Workbench 열기
        </Link>
      </nav>
      <div className={`grid min-h-0 flex-1 ${expanded ? 'grid-cols-1' : 'lg:grid-cols-2'}`}>
        <div className={`${expanded ? 'hidden' : 'min-h-[400px] lg:min-h-0'} border-r`}>
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
                key={`${workbench.experimentId}:${workbench.experimentDocument.resultSessionKey ?? ''}`}
                experiment={workbench.experiment}
                experimentDocument={workbench.experimentDocument}
                onFindSelectionSource={() => {}}
                onSelectionQueryChange={() => {}}
                onSelectionSourcePathsChange={() => {}}
                onToggleViewerExpanded={() => setExpanded((value) => !value)}
                viewerExpanded={expanded}
                selectionQuery={null}
                selectionSourceStatus={{}}
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
