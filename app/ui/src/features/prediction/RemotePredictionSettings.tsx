import { useState, useSyncExternalStore } from 'react'
import type { PredictionModelRecord } from '@/contracts/api/prediction'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RecordedDataRule, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import type { PredictionDirection } from './types'
import type { PredictionAssetController } from './assetManagement'
import { createPredictionModel } from './assetCreation'
import { PredictionModelManager } from './PredictionModelManager'
import { PredictionDatasetManager } from './PredictionDatasetManager'
import { PredictionAssetTasks } from './PredictionAssetTasks'

export type PredictionAssetSettingsProps = Readonly<{
  authenticated: boolean
  open: boolean
  context: PredictionContext | null
  sourceHash: string | null
  varsSchema: Readonly<Record<string, VarsSchemaEntry>> | null
  rules: readonly RecordedDataRule[]
  resultContracts: RecordedResultContracts
  setup: PredictionSetup
  onChange: (setup: PredictionSetup) => void
  onUse?: (setup: PredictionSetup, direction?: PredictionDirection) => void
  manager: PredictionAssetController
  direction?: PredictionDirection
  onBeforeDelete?: () => Promise<void>
  onActivity?: RuntimeActivityCallback
  onBusyChange?: (busy: boolean) => void
  loadedDirections?: readonly PredictionDirection[]
  onReconnect?: () => void
}>

export function RemotePredictionSettings(props: PredictionAssetSettingsProps) {
  const {
    authenticated,
    open,
    context,
    sourceHash,
    varsSchema,
    rules,
    resultContracts,
    setup,
    onChange,
    onUse,
    manager,
    direction = 'forward',
  } = props
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [tab, setTab] = useState<'models' | 'datasets' | 'operations'>('models')
  const [creationOpen, setCreationOpen] = useState(false)
  const [newDirection, setNewDirection] = useState(direction)
  const [launcherId, setLauncherId] = useState('')
  const [datasetId, setDatasetId] = useState(setup.datasetId ?? '')
  const [datasetRevision, setDatasetRevision] = useState<number | undefined>()
  const [name, setName] = useState('')
  const [previous, setPrevious] = useState<PredictionModelRecord | undefined>()
  const [refreshDataset, setRefreshDataset] = useState(false)
  const dataset = state.datasets.find((item) => item.id === datasetId)
  const unresolvedDataset = Boolean(datasetId) && !dataset
  const applyModel = onUse ?? onChange
  const create = async () => {
    if (!context || !sourceHash || !varsSchema || unresolvedDataset) return
    const selection = manager.currentSelectionKey
    const next = await createPredictionModel(manager, {
      context,
      sourceHash,
      varsSchema,
      rules,
      resultContracts,
      setup,
      name,
      launcherId,
      direction: newDirection,
      dataset,
      datasetRevision,
      previous,
      refreshDataset,
    })
    if (next && manager.active && selection === manager.currentSelectionKey) {
      applyModel(next, newDirection)
      setCreationOpen(false)
    }
  }
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="데이터·모델 관리" hidden={!open}>
      <label className="block text-sm font-medium">
        예측 방법
        <select
          aria-label="Prediction 실행 위치"
          className="mt-1 w-full rounded-md border bg-background p-2"
          value={setup.executionId}
          onChange={(event) => onChange({ ...setup, executionId: event.target.value })}
        >
          <option value="browser-knn">브라우저 kNN · 현재 선택 데이터</option>
          <option value="remote-knn" disabled={!authenticated}>
            저장 모델 사용{!authenticated ? ' (로그인 필요)' : ''}
          </option>
        </select>
      </label>
      {setup.executionId === 'browser-knn' ? (
        <p className="text-xs text-muted-foreground">
          브라우저에서는 현재 선택한 데이터로 예측합니다. 장비 연결과 모델 저장은 필요하지 않습니다.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="관리 항목" className="flex flex-wrap gap-1">
              {(
                [
                  ['models', '모델'],
                  ['datasets', '학습 데이터'],
                  ['operations', '작업'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  type="button"
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  size="sm"
                  variant={tab === value ? 'secondary' : 'ghost'}
                  onClick={() => setTab(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={state.loading}
              onClick={() => void manager.refresh()}
            >
              목록 새로고침
            </Button>
          </div>
          {state.error && (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive">
              일부 목록을 불러오지 못했습니다. 이전에 불러온 목록은 유지됩니다.{'\n'}
              {state.error}
            </p>
          )}
          {state.listErrors.launchers ? (
            <p className="text-xs text-muted-foreground">
              장비 목록 조회에 실패했습니다. 목록 새로고침으로 다시 시도하세요.
              {state.launchers.length > 0 && ' 이전에 확인한 장비를 표시합니다.'}
            </p>
          ) : state.loading && state.launchers.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              장비 목록을 불러오는 중입니다.
            </p>
          ) : !state.launchersLoaded ? (
            <p className="text-xs text-muted-foreground">
              장비 목록을 아직 불러오지 않았습니다. 목록 새로고침을 눌러 주세요.
            </p>
          ) : state.launchers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Predictor를 지원하는 장비가 없습니다. 설정의 Launchers에서 장비의 지원 앱을 확인하세요.
            </p>
          ) : null}
          {tab === 'models' && (
            <div role="tabpanel" aria-label="모델 관리" className="space-y-3">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setPrevious(undefined)
                  setNewDirection(direction)
                  setName('')
                  setRefreshDataset(false)
                  setDatasetRevision(undefined)
                  setCreationOpen(true)
                }}
              >
                새 모델 만들기
              </Button>
              <PredictionModelManager
                manager={manager}
                setup={setup}
                onChange={onChange}
                onUse={applyModel}
                onNewVersion={(model) => {
                  setPrevious(model)
                  setNewDirection(model.direction)
                  setName(model.name)
                  setDatasetId(
                    model.revisions.find((item) => item.revision === model.current_revision)?.dataset_id ?? '',
                  )
                  setDatasetRevision(
                    model.revisions.find((item) => item.revision === model.current_revision)?.dataset_revision,
                  )
                  setRefreshDataset(false)
                  setCreationOpen(true)
                }}
              />
              {creationOpen && (
                <section className="space-y-3 rounded border bg-muted/20 p-3" aria-label="모델 만들기">
                  <h4 className="text-sm font-medium">
                    {previous ? `${previous.name} · 새 버전` : '모델 만들고 사용'}
                  </h4>
                  <Input
                    aria-label="새 모델 이름"
                    placeholder="모델 이름 (비우면 데이터와 방향으로 제안)"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <label className="block text-sm">
                    예측 방향
                    <select
                      aria-label="만들 모델 방향"
                      className="mt-1 w-full rounded border bg-background p-2"
                      value={newDirection}
                      disabled={Boolean(previous)}
                      onChange={(event) => setNewDirection(event.target.value as PredictionDirection)}
                    >
                      <option value="forward">Forward · Vars에서 결과 예측</option>
                      <option value="inverse">Inverse · Target에서 Vars 제안</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    학습 데이터
                    <select
                      aria-label="모델 학습 데이터"
                      className="mt-1 w-full rounded border bg-background p-2"
                      value={datasetId}
                      onChange={(event) => {
                        setDatasetId(event.target.value)
                        setDatasetRevision(undefined)
                        setRefreshDataset(false)
                      }}
                    >
                      <option value="">현재 선택 데이터로 만들기</option>
                      {unresolvedDataset && <option value={datasetId}>선택한 학습 데이터 · 확인 필요</option>}
                      {state.datasets
                        .filter((item) => item.state === 'active')
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · r{item.current_revision}
                          </option>
                        ))}
                    </select>
                  </label>
                  {unresolvedDataset && (
                    <p className="text-xs text-muted-foreground">
                      선택한 학습 데이터를 목록에서 확인할 수 없습니다. 목록을 새로고침하거나 현재 선택 데이터로
                      만들기를 직접 선택하세요.
                    </p>
                  )}
                  {dataset && (
                    <label className="block text-sm">
                      학습 데이터 버전
                      <select
                        aria-label="모델 학습 데이터 버전"
                        className="mt-1 w-full rounded border bg-background p-2"
                        value={datasetRevision ?? dataset.current_revision}
                        disabled={refreshDataset}
                        onChange={(event) => setDatasetRevision(Number(event.target.value))}
                      >
                        {dataset.revisions.map((item) => (
                          <option key={item.revision} value={item.revision} disabled={!item.payload_available}>
                            r{item.revision} · {item.sample_count ?? '?'} 표본
                            {item.revision === dataset.current_revision ? ' · 최신' : ' · 보관본'}
                            {!item.payload_available ? ' · 원본 없음' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {dataset && (
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={refreshDataset}
                        onChange={(event) => setRefreshDataset(event.target.checked)}
                      />
                      새 데이터를 반영한 뒤 모델 만들기
                    </label>
                  )}
                  <label className="block text-sm">
                    준비·실행 장비
                    <select
                      aria-label="모델 생성 장비"
                      className="mt-1 w-full rounded border bg-background p-2"
                      value={launcherId}
                      onChange={(event) => setLauncherId(event.target.value)}
                    >
                      <option value="">장비 선택</option>
                      {state.launchers.map((launcher) => (
                        <option key={launcher.id} value={launcher.id}>
                          {launcher.launcher_name} · {launcher.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    현재 선택한 Calculation과 아래 새 버전 작성안의 k·거리 설정을 사용합니다. 파일 저장과 등록이 모두
                    성공하면 해당 방향의 모델을 전환합니다.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        !context ||
                        !sourceHash ||
                        !varsSchema ||
                        unresolvedDataset ||
                        !launcherId ||
                        !setup.calculationIds.length ||
                        state.tasks.some(
                          (task) =>
                            task.state === 'running' && task.key === `model:${previous?.id ?? newDirection}:create`,
                        )
                      }
                      onClick={() => void create()}
                    >
                      모델 만들고 사용
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setCreationOpen(false)}>
                      닫기
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}
          {tab === 'datasets' && <PredictionDatasetManager {...props} />}
          {tab === 'operations' && <PredictionAssetTasks manager={manager} />}
          {state.tasks.some((task) => task.state === 'running') && tab !== 'operations' && (
            <button
              type="button"
              role="status"
              className="text-xs text-primary underline"
              onClick={() => setTab('operations')}
            >
              진행 중인 관리 작업 보기 · 화면을 닫아도 계속됩니다.
            </button>
          )}
        </>
      )}
    </section>
  )
}
