import { useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable } from '@/components/DataTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { availableExperimentsQueryOptions } from '@/features/experiment/queryOptions'
import { usePredictionAssets } from './usePredictionAssets'
import { predictionReplicaStatus } from './assetManagement'
import { PredictionDatasetDetail } from './PredictionDatasetManager'
import { PredictionDatasetCreate } from './PredictionDatasetCreate'
import { ModelDetail } from './PredictionModelManager'
import { PredictionAssetTasks } from './PredictionAssetTasks'
import { defaultPredictionSetup } from './usePredictionModels'
import { startPredictionAssetOperation, verifyPredictionReplica } from './assetOperations'
import {
  predictionFileRows,
  visiblePredictionFiles,
  predictionFileActionReason,
  predictionRemovalSummary,
  type PredictionFileRow,
} from './assetFiles'

const states: Record<string, string> = {
  present: '파일 확인 완료',
  unverified: '파일 미검증',
  missing: '파일 없음',
  corrupt: '파일 손상',
  deleting: '삭제 확인 대기',
  none: '복사본 없음',
}
const kinds: Record<string, string> = {
  predictor_local: 'Predictor 저장소',
  object_backup: '백업 저장소',
  api_dataset: '서버 원본',
  none: '저장 위치 없음',
}

export function PredictionFilesPage() {
  const auth = useAuth()
  if (auth.isPending)
    return (
      <main role="status" className="p-6">
        로그인 상태를 확인하는 중…
      </main>
    )
  if (!auth.isAuthenticated)
    return (
      <WorkbenchSignInPrompt
        description="모델·데이터셋을 관리하려면 로그인하세요."
        onSignIn={() => {
          window.location.href = `/account?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`
        }}
      />
    )
  return <PredictionFilesWorkspace key={auth.queryScope} scope={auth.queryScope} />
}

export function PredictionFilesWorkspace({ scope }: { scope: PrivateQueryScope }) {
  const [params, setParams] = useSearchParams()
  const kind = params.get('tab') === 'datasets' ? 'dataset' : 'model'
  return (
    <div className="h-full overflow-auto">
      <div role="tablist" aria-label="통합 관리 항목" className="flex gap-2 px-4 pt-4">
        {(['model', 'dataset'] as const).map((item) => (
          <Button
            key={item}
            role="tab"
            aria-selected={kind === item}
            variant={kind === item ? 'secondary' : 'ghost'}
            onClick={() => {
              if (item === kind) return
              const next = new URLSearchParams(params)
              if (item === 'dataset') next.set('tab', 'datasets')
              else next.delete('tab')
              for (const key of [
                'model',
                'dataset',
                'source',
                'revision',
                'page',
                'state',
                'kind',
                'q',
                'launcher',
                'sort',
                'order',
              ])
                next.delete(key)
              setParams(next)
            }}
          >
            {item === 'model' ? '모델' : '데이터셋'}
          </Button>
        ))}
      </div>
      <PredictionFilesTable key={kind} scope={scope} kind={kind} />
    </div>
  )
}

function PredictionFilesTable({ scope, kind }: { scope: PrivateQueryScope; kind: 'model' | 'dataset' }) {
  const manager = usePredictionAssets(scope, 'all')
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const experiments = useQuery(availableExperimentsQueryOptions(scope))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [detailKey, setDetailKey] = useState<string>()
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchResults, setBatchResults] = useState<{ message: string; taskKey?: string }[]>([])
  const label = kind === 'model' ? '모델' : '데이터셋'
  const rows = useMemo(() => predictionFileRows(state, kind), [state, kind])
  const filtered = useMemo(() => visiblePredictionFiles(rows, params), [rows, params])
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50))
  const requestedPage = Number(params.get('page') ?? 1)
  const page = Number.isSafeInteger(requestedPage) ? Math.min(pageCount, Math.max(1, requestedPage)) : 1
  const pageRows = filtered.slice((page - 1) * 50, page * 50)
  const selectedRows = rows.filter((row) => selected.has(row.key))
  const detail = rows.find((row) => row.key === detailKey)
  const experimentNames = new Map(
    [...(experiments.data?.mine ?? []), ...(experiments.data?.demos ?? [])].map((item) => [item.id, item.name]),
  )
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') {
      next.delete('page')
      setSelected(new Set())
    }
    setParams(next, { replace: true })
  }
  const sort = (key: string) => {
    const next = new URLSearchParams(params)
    next.set('sort', key)
    next.set('order', params.get('sort') === key && params.get('order') !== 'desc' ? 'desc' : 'asc')
    next.delete('page')
    setParams(next, { replace: true })
  }
  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const runBatch = async (action: 'verify' | 'remove') => {
    const eligible = selectedRows.filter((row) => !predictionFileActionReason(row, action, state))
    if (!eligible.length) {
      setBatchResults([{ message: '선택한 항목 중 실행 가능한 복사본이 없습니다. 제외 사유를 확인하세요.' }])
      return
    }
    if (
      action === 'remove' &&
      !window.confirm(
        `선택한 복사본 ${eligible.length}개를 제거할까요?\n${predictionRemovalSummary(rows, eligible)}\n${kind === 'model' ? '모델 기록과 학습 데이터는 유지됩니다. 현재 화면에서 사용 중인 해당 복사본은 해제합니다.' : 'Dataset 기록과 저장 모델·원본 Measurement는 유지됩니다.'}`,
      )
    )
      return
    setBatchRunning(true)
    setBatchResults(
      selectedRows
        .filter((row) => predictionFileActionReason(row, action, state))
        .map((row) => ({
          message: `${row.asset.name} r${row.revision.revision}: 제외 · ${predictionFileActionReason(row, action, state)}`,
        })),
    )
    try {
      for (const row of eligible) {
        const result =
          action === 'verify'
            ? await verifyPredictionReplica(manager, kind, row.asset.id, row.revision.revision, row.replica!.id)
            : await startPredictionAssetOperation(manager, {
                kind: 'delete_replica',
                asset_kind: kind,
                asset_id: row.asset.id,
                revision: row.revision.revision,
                replica_id: row.replica!.id,
              })
        setBatchResults((previous) => [
          ...previous,
          {
            taskKey: `${action === 'verify' ? 'verify' : 'delete_replica'}:${row.asset.id}:${row.revision.revision}:${row.replica!.id}`,
            message: `${row.asset.name} r${row.revision.revision} · ${row.storage?.name ?? '저장소'}: ${!result ? '실패' : result.state === 'completed' ? '완료' : '확인 대기'}`,
          },
        ])
      }
    } finally {
      setBatchRunning(false)
      await manager.refresh()
    }
  }
  const columns: ColumnDef<PredictionFileRow, unknown>[] = [
    {
      id: 'select',
      header: () => (
        <input
          type="checkbox"
          aria-label="현재 페이지 복사본 모두 선택"
          checked={
            pageRows.some((row) => row.replica) &&
            pageRows.filter((row) => row.replica).every((row) => selected.has(row.key))
          }
          onChange={(event) =>
            setSelected((previous) => {
              const next = new Set(previous)
              for (const row of pageRows)
                if (row.replica) {
                  if (event.target.checked) next.add(row.key)
                  else next.delete(row.key)
                }
              return next
            })
          }
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`${row.original.asset.name} r${row.original.revision.revision} ${row.original.storage?.name ?? '복사본 없음'} 선택`}
          disabled={!row.original.replica}
          checked={selected.has(row.original.key)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={() => toggle(row.original.key)}
        />
      ),
    },
    {
      id: 'experiment',
      header: 'Experiment',
      cell: ({ row }) =>
        experimentNames.get(row.original.asset.experiment_id) ?? `Experiment #${row.original.asset.experiment_id}`,
    },
    {
      id: 'name',
      header: () => <button onClick={() => sort('name')}>{label}명 ↕</button>,
      cell: ({ row }) => <span className="block max-w-72 min-w-36 break-words">{row.original.asset.name}</span>,
    },
    {
      id: 'direction',
      header: kind === 'model' ? '지원 상태' : '원본 종류',
      cell: ({ row }) =>
        row.original.kind === 'model'
          ? row.original.asset.direction === 'forward'
            ? 'Forward'
            : 'Inverse · 지원 종료'
          : row.original.asset.source_kind === 'server'
            ? '서버 데이터'
            : '외부 가져오기',
    },
    {
      id: 'revision',
      header: () => <button onClick={() => sort('revision')}>Revision ↕</button>,
      cell: ({ row }) =>
        `r${row.original.revision.revision}${kind === 'dataset' && row.original.revision.revision === row.original.asset.current_revision ? ' · 최신' : ''}`,
    },
    {
      id: 'storage',
      header: '저장 위치·종류',
      cell: ({ row }) => (
        <span>
          {row.original.storage?.name ?? '복사본 없음'}
          <br />
          {kinds[row.original.storage?.kind ?? 'none']}
        </span>
      ),
    },
    {
      id: 'launcher',
      header: () => <button onClick={() => sort('launcher')}>런처 ↕</button>,
      cell: ({ row }) => row.original.launcherNames || '—',
    },
    {
      id: 'state',
      header: '파일 상태',
      cell: ({ row }) => (
        <span>
          {row.original.kind === 'dataset' && !row.original.replica
            ? '출처 기록만 보존'
            : states[row.original.replica?.state ?? 'none']}
          <br />
          {row.original.replica?.deletion?.message}
        </span>
      ),
    },
    {
      id: 'connection',
      header: '연결 상태',
      cell: ({ row }) =>
        row.original.storage?.kind === 'predictor_local'
          ? row.original.storage.accesses.some((access) => access.connected)
            ? '연결 가능'
            : '오프라인'
          : '—',
    },
    {
      id: 'bytes',
      header: () => <button onClick={() => sort('bytes')}>등록 용량 ↕</button>,
      cell: ({ row }) => (row.original.bytes === null ? '알 수 없음' : `${row.original.bytes.toLocaleString()} B`),
    },
    {
      id: 'checked',
      header: () => <button onClick={() => sort('checked')}>마지막 확인 ↕</button>,
      cell: ({ row }) =>
        row.original.replica?.checked_at ? new Date(row.original.replica.checked_at).toLocaleString() : '미확인',
    },
  ]
  if (kind === 'dataset')
    columns.splice(4, 0, {
      id: 'samples',
      header: () => <button onClick={() => sort('samples')}>표본 수 ↕</button>,
      cell: ({ row }) => (row.original.kind === 'dataset' ? (row.original.revision.sample_count ?? '알 수 없음') : '—'),
    })
  const filters = [
    {
      key: 'experiment',
      label: 'Experiment',
      options: [...new Set(rows.map((row) => row.asset.experiment_id))].map((id) => [
        String(id),
        experimentNames.get(id) ?? `Experiment #${id}`,
      ]),
    },
    {
      key: kind,
      label,
      options: (kind === 'model' ? state.models : state.datasets).map((asset) => [asset.id, asset.name]),
    },
    {
      key: 'revision',
      label: 'Revision',
      options: [...new Set(rows.map((row) => row.revision.revision))]
        .sort((a, b) => a - b)
        .map((revision) => [String(revision), `r${revision}`]),
    },
    {
      key: 'launcher',
      label: '런처',
      options: state.launchers.map((launcher) => [launcher.id, launcher.launcher_name]),
    },
    { key: 'kind', label: '저장 종류', options: Object.entries(kinds) },
    { key: 'state', label: '파일 상태', options: Object.entries(states) },
    ...(kind === 'dataset'
      ? [
          {
            key: 'source',
            label: '원본 종류',
            options: [
              ['server', '서버 데이터'],
              ['local', '외부 가져오기'],
            ],
          },
        ]
      : []),
  ]
  return (
    <main className="space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/settings" className="text-sm underline">
            Setting
          </Link>
          <h1 className="text-xl font-semibold">모델·데이터셋 관리</h1>
        </div>
        <Button
          variant="outline"
          disabled={state.loading}
          onClick={() => {
            void manager.refresh()
            void experiments.refetch()
          }}
        >
          목록 새로고침
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        내 모든 Experiment의 {label} 복사본입니다. 목록 조회는 장비에 연결하지 않습니다. 삭제 대기는 상세에서 계속할 수
        있습니다.
      </p>
      {kind === 'dataset' && (
        <PredictionDatasetCreate
          scope={scope}
          manager={manager}
          experiments={experiments.data?.mine ?? []}
          experimentsError={experiments.error}
          onCreated={(id) => {
            const next = new URLSearchParams({ tab: 'datasets', dataset: id })
            setParams(next)
            setSelected(new Set())
            setDetailKey(undefined)
          }}
        />
      )}
      {state.error && (
        <p role="alert" className="whitespace-pre-line text-destructive">
          {state.error} 이전에 조회한 목록을 유지합니다.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Input
          className="w-64"
          aria-label={`${label}명 검색`}
          placeholder={`${label}명 검색`}
          value={params.get('q') ?? ''}
          onChange={(event) => change('q', event.target.value)}
        />
        {filters.map((filter) => (
          <label key={filter.key} className="text-sm">
            {filter.label}
            <select
              aria-label={`${filter.label} 필터`}
              className="ml-2 max-w-56 rounded border bg-background p-2"
              value={params.get(filter.key) ?? ''}
              onChange={(event) => change(filter.key, event.target.value)}
            >
              <option value="">전체</option>
              {filter.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <Button
          variant="ghost"
          onClick={() => {
            setParams(kind === 'dataset' ? { tab: 'datasets' } : {})
            setSelected(new Set())
          }}
        >
          조건 초기화
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">
          {filtered.length}행 · {selectedRows.length}개 선택
        </span>
        <Button
          variant="outline"
          disabled={batchRunning || !selectedRows.length}
          onClick={() => void runBatch('verify')}
        >
          선택 파일 확인
        </Button>
        <Button
          variant="outline"
          disabled={batchRunning || !selectedRows.length}
          onClick={() => void runBatch('remove')}
        >
          선택 복사본 제거
        </Button>
      </div>
      {selectedRows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {selectedRows
            .filter((row) => predictionFileActionReason(row, 'verify', state))
            .map(
              (row) =>
                `${row.asset.name} r${row.revision.revision}: 파일 확인 제외 · ${predictionFileActionReason(row, 'verify', state)}`,
            )
            .join(' · ')}
        </p>
      )}
      <div className="overflow-x-auto rounded border [&_table]:min-w-[1100px]">
        <DataTable
          columns={columns}
          data={pageRows}
          getRowKey={(row) => row.key}
          onRowClick={(row) => setDetailKey(row.key)}
          selectedKey={detailKey}
          emptyLabel={state.loading ? `${label} 파일 목록을 불러오는 중…` : `조건에 맞는 ${label} 파일이 없습니다.`}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" disabled={page <= 1} onClick={() => change('page', String(page - 1))}>
          이전
        </Button>
        <span>
          {page} / {pageCount} · 페이지당 50행
        </span>
        <Button variant="outline" disabled={page >= pageCount} onClick={() => change('page', String(page + 1))}>
          다음
        </Button>
      </div>
      {batchResults.length > 0 && (
        <ul aria-label="일괄 작업 결과" className="space-y-1 text-sm">
          {batchResults.map((result, index) => {
            const task = state.tasks.find((item) => item.key === result.taskKey)
            return (
              <li key={index} className="flex flex-wrap items-center gap-2">
                <span>
                  {result.message}
                  {task ? ` · 현재 상태: ${task.message}` : ''}
                </span>
                {task && ['failed', 'waiting'].includes(task.state) && (
                  <Button size="sm" variant="outline" onClick={() => void manager.retryTask(task.id)}>
                    이 항목 상태 확인·재시도
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {detail && (
        <section aria-label={`선택한 ${label} 파일 상세`} className="space-y-3">
          <h2 className="font-semibold">
            {detail.asset.name} · r{detail.revision.revision}
          </h2>
          <p className="text-sm">
            {detail.replica
              ? predictionReplicaStatus(detail.replica, detail.storage)
              : kind === 'model'
                ? '복사본 없음 · 모델 기록은 유지됩니다.'
                : '출처 기록만 보존'}
          </p>
          <p className="text-xs text-muted-foreground">
            아래 파일명·길이·checksum은 등록 metadata입니다. 현재 파일 검증 상태와는 별개입니다.
          </p>
          <ul className="space-y-1 text-xs break-all">
            {detail.files.map((file) => (
              <li key={file.name}>
                {file.name} · {file.byteLength === null ? '길이 미확인' : `${file.byteLength.toLocaleString()} B`} ·{' '}
                {file.sha256 ?? 'checksum 미확인'}
              </li>
            ))}
          </ul>
          {detail.kind === 'dataset' && !detail.files.length && (
            <p className="text-xs break-all text-muted-foreground">
              등록된 개별 파일 정보 없음 · 용량 알 수 없음 · manifest checksum:{' '}
              {detail.replica?.manifest_sha256 ?? '알 수 없음'}
            </p>
          )}
          {detail.kind === 'dataset' ? (
            <PredictionDatasetDetail
              key={`${detail.key}:${detail.asset.current_revision}`}
              manager={manager}
              dataset={detail.asset}
              initialRevision={detail.revision.revision}
            />
          ) : (
            <ModelDetail
              key={detail.key}
              manager={manager}
              model={detail.asset}
              initialRevision={detail.revision.revision}
              managementOnly
              setup={defaultPredictionSetup}
              onChange={() => undefined}
              onUse={() => undefined}
              onNewVersion={() => undefined}
            />
          )}
          <details>
            <summary className="cursor-pointer text-sm font-medium">이 {label}의 관련 작업</summary>
            <PredictionAssetTasks manager={manager} assetId={detail.asset.id} />
          </details>
        </section>
      )}
      <details open={batchRunning}>
        <summary className="cursor-pointer font-medium">관리 작업·오류·재시도</summary>
        <PredictionAssetTasks manager={manager} />
      </details>
    </main>
  )
}
