import { useCallback, useEffect, useRef, useState } from 'react'
import { GpStationClient, type LauncherView } from '@gpstation/v1-master-js-sdk'
import { browserClient } from '@/api/http'
import { predictionApi } from '@/api/prediction'
import type { PredictionDatasetGrant, PredictionDatasetRecord, PredictionModelRecord } from '@/contracts/api/prediction'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RecordedDataRule, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import type { PredictionDirection } from './types'
import { RemotePredictionExecution, type RemotePredictionState } from './remoteExecution'
import { reconcileRemoteAssets, registerRemoteArtifact, savedModelReference } from './remoteAssets'
import { assertSavedPredictionCompatible, savedContractFromSource } from './savedModels'
import { predictionFingerprint } from './data'
import { remoteDatasetSchema, type RemoteHello } from './remoteProtocol'

export function RemotePredictionSettings({
  authenticated,
  open,
  context,
  sourceHash,
  varsSchema,
  rules,
  resultContracts,
  setup,
  onChange,
  onBeforeDelete,
  onActivity,
  onBusyChange,
  loadedDirections = [],
  onReconnect,
}: Readonly<{
  authenticated: boolean
  open: boolean
  context: PredictionContext | null
  sourceHash: string | null
  varsSchema: Readonly<Record<string, VarsSchemaEntry>> | null
  rules: readonly RecordedDataRule[]
  resultContracts: RecordedResultContracts
  setup: PredictionSetup
  onChange: (setup: PredictionSetup) => void
  onBeforeDelete: () => Promise<void>
  onActivity?: RuntimeActivityCallback
  onBusyChange?: (busy: boolean) => void
  loadedDirections?: readonly PredictionDirection[]
  onReconnect?: () => void
}>) {
  const [launchers, setLaunchers] = useState<LauncherView[]>([])
  const [datasets, setDatasets] = useState<PredictionDatasetRecord[]>([])
  const [models, setModels] = useState<PredictionModelRecord[]>([])
  const [datasetId, setDatasetId] = useState(setup.datasetId ?? '')
  const [name, setName] = useState('')
  const [importId, setImportId] = useState('')
  const [files, setFiles] = useState<RemoteHello | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [connection, setConnection] = useState<RemotePredictionState>('disconnected')
  const executionRef = useRef<RemotePredictionExecution | null>(null)
  const operationRef = useRef<AbortController | null>(null)
  const dataset = datasets.find((item) => item.id === datasetId)
  const enabled = authenticated && open && setup.executionId === 'remote-knn'
  useEffect(() => {
    setDatasetId(setup.datasetId ?? '')
  }, [setup.datasetId, context?.experimentId])
  useEffect(() => {
    onBusyChange?.(Boolean(working))
    return () => onBusyChange?.(false)
  }, [working, onBusyChange])

  const refresh = useCallback(async () => {
    if (!context) return
    const client = new GpStationClient({
      apiBaseUrl: browserClient.baseUrl,
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    })
    const [nextLaunchers, nextDatasets, nextModels] = await Promise.all([
      client.listLaunchers(),
      predictionApi.datasets(context.experimentId),
      predictionApi.models(context.experimentId),
    ])
    setLaunchers(nextLaunchers.filter((item) => item.slave_app_ids.includes('predictor')))
    setDatasets(nextDatasets)
    setModels(nextModels)
    setDatasetId((current) =>
      nextDatasets.some((item) => item.id === current) ? current : (nextDatasets[0]?.id ?? ''),
    )
  }, [context])

  useEffect(() => {
    if (enabled)
      void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
    return () => {
      operationRef.current?.abort()
      executionRef.current?.dispose()
      executionRef.current = null
    }
  }, [enabled, refresh, setup.launcherId])

  const execution = () => {
    if (!setup.launcherId) throw new Error('Predictor 장비를 선택하세요.')
    if (
      !executionRef.current ||
      executionRef.current.state === 'failed' ||
      executionRef.current.state === 'disconnected'
    ) {
      executionRef.current?.dispose()
      executionRef.current = new RemotePredictionExecution(setup.launcherId, {
        onState: setConnection,
        onHello: async (hello) => {
          await reconcileRemoteAssets(hello)
          setFiles(hello)
        },
      })
    }
    return executionRef.current
  }

  const run = async (label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (working) return
    const abort = new AbortController()
    operationRef.current = abort
    setWorking(label)
    setMessage('')
    try {
      await action(abort.signal)
      if (!abort.signal.aborted) {
        await refresh()
        setMessage(`${label} 완료`)
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const text = error instanceof Error ? error.message : String(error)
        setMessage(text)
        onActivity?.({ source: 'prediction', level: 'error', phase: 'assets', message: text })
      }
    } finally {
      if (operationRef.current === abort) {
        operationRef.current = null
        setWorking(null)
      }
    }
  }

  const selection = () => {
    if (!context || !varsSchema || !sourceHash) throw new Error('저장된 Experiment와 Vars 계약을 먼저 준비하세요.')
    const selected = context.calculations.filter((item) => setup.calculationIds.includes(item.id))
    return {
      request_id: crypto.randomUUID(),
      name: name.trim() || dataset?.name || `Experiment ${context.experimentId} Dataset`,
      experiment_id: context.experimentId,
      source_hash: sourceHash,
      vars_schema: varsSchema,
      calculation_ids: [...setup.calculationIds],
      record_ids: [...new Set(selected.flatMap((item) => item.experiment_record_ids))],
      rules,
      result_contracts: resultContracts,
    }
  }

  const buildModel = async (direction: PredictionDirection, update: boolean, signal: AbortSignal) => {
    if (!dataset || !context || !varsSchema) throw new Error('Dataset과 Experiment를 먼저 선택하세요.')
    const remote = execution()
    const hello = await remote.inspect({ requestId: crypto.randomUUID(), signal })
    const source = dataset.revisions.find((item) => item.revision === dataset.current_revision)
    if (!source?.payload_available || dataset.state !== 'active')
      throw new Error('Dataset 최신 데이터를 사용할 수 없습니다.')
    const requiredRecordIds = [
      ...new Set(
        context.calculations
          .filter((item) => setup.calculationIds.includes(item.id))
          .flatMap((item) => item.experiment_record_ids),
      ),
    ]
    const frozenContract = savedContractFromSource(source.source_contracts)
    const contract = {
      ...frozenContract,
      records: Object.fromEntries(requiredRecordIds.map((id) => [id, frozenContract.records[id]])),
      calculations: Object.fromEntries(setup.calculationIds.map((id) => [id, frozenContract.calculations[id]])),
    }
    assertSavedPredictionCompatible(
      {
        modelId: '',
        modelRevision: 0,
        datasetId: dataset.id,
        datasetRevision: dataset.current_revision,
        direction,
        fingerprint: '',
        storageId: hello.storageId,
        launcherId: hello.launcherId,
        contract,
      },
      context,
      varsSchema,
      requiredRecordIds,
      setup.calculationIds,
    )
    const meaning = {
      snapshotFingerprint: source.fingerprint,
      algorithm: setup.algorithm,
      implementationId: remote.id,
      implementationVersion: remote.implementationVersion,
      preprocessingVersion: remote.preprocessingVersion,
      contract,
      direction,
      calculationIds: setup.calculationIds,
      requiredRecordIds,
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(predictionFingerprint([meaning])))
    const fingerprint = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    const definition = { ...meaning, fingerprint }
    const previous = update ? setup.models?.[direction] : undefined
    const reserved = await predictionApi.reserve(
      {
        request_id: crypto.randomUUID(),
        name: name.trim() || `${dataset.name} · ${direction === 'forward' ? 'Forward' : 'Inverse'}`,
        direction,
        dataset_id: dataset.id,
        dataset_revision: dataset.current_revision,
        definition,
        storage_id: hello.storageId,
        launcher_id: hello.launcherId,
        ...(previous
          ? {
              model_id: previous.modelId,
              expected_revision: models.find((item) => item.id === previous.modelId)?.current_revision,
            }
          : {}),
      },
      { signal },
    )
    let grant: PredictionDatasetGrant | undefined
    try {
      if (dataset.source_kind === 'server')
        grant = await predictionApi.grant(dataset.id, dataset.current_revision, { signal })
      else if (dataset.storage_id !== hello.storageId) throw new Error('선택한 장비에 로컬 Dataset이 없습니다.')
      const prepared = await remote.prepare(
        {
          kind: 'dataset-revision',
          direction,
          fingerprint: source.fingerprint,
          dataset: grant
            ? { grant }
            : { datasetId: dataset.id, revision: dataset.current_revision, fingerprint: source.fingerprint },
          model: {
            modelId: reserved.id,
            revision: reserved.reserved_revision!,
            operationId: reserved.operation_id!,
            name: reserved.name,
          },
        },
        definition,
        { requestId: crypto.randomUUID(), signal },
      )
      try {
        const complete = await registerRemoteArtifact(prepared.artifact)
        if (!signal.aborted)
          onChange({ ...setup, models: { ...setup.models, [direction]: savedModelReference(complete) } })
      } finally {
        await remote.release(prepared.instance)
      }
    } finally {
      if (grant) await predictionApi.releaseGrant(dataset.id, grant.grant_id)
    }
  }

  const deleteAsset = async (
    kind: 'datasets' | 'models',
    asset: PredictionDatasetRecord | PredictionModelRecord,
    signal: AbortSignal,
  ) => {
    if (
      !window.confirm(
        `${asset.name}의 ${kind === 'models' ? '모든 모델 revision과 파일' : 'Dataset 데이터'}을 삭제할까요?${kind === 'datasets' ? ' 원본과 저장 모델은 유지됩니다.' : ''}`,
      )
    )
      return
    await onBeforeDelete()
    const remote = asset.storage_id ? execution() : null
    if (remote) {
      const hello = await remote.inspect({ requestId: crypto.randomUUID(), signal })
      if (hello.storageId !== asset.storage_id) throw new Error('이 자산이 저장된 장비에 연결하세요.')
    }
    const request = {
      request_id: asset.delete_id ?? crypto.randomUUID(),
      storage_id: asset.storage_id,
      launcher_id: asset.launcher_id,
    }
    await predictionApi.deleteAsset(kind, asset.id, request, false, { signal })
    if (remote) {
      await remote.command(
        kind === 'models' ? 'model.delete' : 'dataset.delete',
        kind === 'models' ? { modelId: asset.id } : { datasetId: asset.id },
        { requestId: crypto.randomUUID(), signal },
      )
      await predictionApi.deleteAsset(kind, asset.id, request, true, { signal })
    }
    if (kind === 'models')
      onChange({
        ...setup,
        models: Object.fromEntries(Object.entries(setup.models ?? {}).filter(([, item]) => item.modelId !== asset.id)),
      })
  }

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Prediction 실행 및 저장 모델">
      <label className="block text-sm font-medium">
        Execution
        <select
          aria-label="Prediction 실행 위치"
          className="mt-1 w-full rounded-md border bg-background p-2"
          value={setup.executionId}
          disabled={Boolean(working)}
          onChange={(event) => onChange({ ...setup, executionId: event.target.value })}
        >
          <option value="browser-knn">브라우저 · kNN</option>
          <option value="remote-knn" disabled={!authenticated}>
            원격 Predictor · kNN{!authenticated ? ' (로그인 필요)' : ''}
          </option>
        </select>
      </label>
      {setup.executionId === 'remote-knn' && (
        <>
          <label className="block text-sm">
            장비
            <select
              aria-label="Predictor 장비"
              className="mt-1 w-full rounded-md border bg-background p-2"
              disabled={Boolean(working)}
              value={setup.launcherId ?? ''}
              onChange={(event) => onChange({ ...setup, launcherId: event.target.value, models: {} })}
            >
              <option value="">장비 선택</option>
              {launchers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.launcher_name} · {item.status}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>연결 · {connection}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working) || !setup.launcherId}
              onClick={() =>
                void run('장비 확인', async (signal) => {
                  await execution().inspect({ requestId: crypto.randomUUID(), signal })
                })
              }
            >
              연결 / 저장 파일 확인
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working)}
              onClick={() => {
                executionRef.current?.dispose()
                executionRef.current = null
              }}
            >
              연결 해제
            </Button>
            {onReconnect && (
              <Button size="sm" variant="outline" disabled={Boolean(working)} onClick={onReconnect}>
                Prediction 다시 연결
              </Button>
            )}
          </div>
          <Input
            aria-label="새 Dataset 또는 모델 이름"
            value={name}
            placeholder="새 Dataset 또는 모델 이름 (선택)"
            onChange={(event) => setName(event.target.value)}
            disabled={Boolean(working)}
          />
          <div className="flex gap-2">
            <Input
              aria-label="로컬 Dataset import ID"
              value={importId}
              placeholder="장비에 준비한 Dataset import ID"
              onChange={(event) => setImportId(event.target.value)}
              disabled={Boolean(working)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working) || !setup.launcherId || !importId.trim()}
              onClick={() =>
                void run('로컬 Dataset 가져오기', async (signal) => {
                  const remote = execution()
                  await remote.inspect({ requestId: crypto.randomUUID(), signal })
                  const imported = await remote.command(
                    'dataset.import',
                    { importId: importId.trim(), experimentId: context?.experimentId },
                    { requestId: crypto.randomUUID(), signal },
                  )
                  await remote.inspect({ requestId: crypto.randomUUID(), signal })
                  const importedDataset = remoteDatasetSchema.parse(imported.dataset)
                  setDatasetId(importedDataset.datasetId)
                  onChange({ ...setup, datasetId: importedDataset.datasetId })
                })
              }
            >
              로컬 Dataset 가져오기
            </Button>
          </div>
          <label className="block text-sm">
            Dataset
            <select
              aria-label="Prediction Dataset"
              className="mt-1 w-full rounded-md border bg-background p-2"
              value={datasetId}
              disabled={Boolean(working)}
              onChange={(event) => {
                setDatasetId(event.target.value)
                onChange({ ...setup, datasetId: event.target.value || undefined })
              }}
            >
              <option value="">Dataset 선택</option>
              {datasets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · r{item.current_revision} · {item.source_kind} · {item.state}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working) || !setup.calculationIds.length}
              onClick={() =>
                void run('Dataset 만들기', async (signal) => {
                  const item = await predictionApi.createDataset(selection(), { signal })
                  setDatasetId(item.id)
                  onChange({ ...setup, datasetId: item.id })
                })
              }
            >
              Dataset 만들기
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working) || !dataset}
              onClick={() =>
                void run('Dataset 동기화', async (signal) => {
                  if (!dataset) return
                  if (dataset.source_kind === 'local') {
                    const remote = execution()
                    await remote.inspect({ requestId: crypto.randomUUID(), signal })
                    await remote.command(
                      'dataset.sync',
                      { datasetId: dataset.id, experimentId: context?.experimentId },
                      { requestId: crypto.randomUUID(), signal },
                    )
                    await remote.inspect({ requestId: crypto.randomUUID(), signal })
                    return
                  }
                  await predictionApi.syncDataset(
                    dataset.id,
                    { ...selection(), name: dataset.name, expected_revision: dataset.current_revision },
                    { signal },
                  )
                })
              }
            >
              Dataset 동기화
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(working) || !dataset}
              onClick={() => dataset && void run('Dataset 삭제', (signal) => deleteAsset('datasets', dataset, signal))}
            >
              Dataset 삭제
            </Button>
          </div>
          {dataset && (
            <p className="text-xs text-muted-foreground">
              {dataset.id} · 최신 r{dataset.current_revision} 데이터 보존 · 이전 revision은 출처 기록만 보존. 동기화는
              저장 모델을 변경하지 않습니다.
            </p>
          )}
          {(['forward', 'inverse'] as const).map((direction) => {
            const selected = setup.models?.[direction]
            const selectedAsset = models.find((item) => item.id === selected?.modelId)
            const file =
              selected &&
              files?.models.find(
                (item) => item.modelId === selected.modelId && item.revision === selected.modelRevision,
              )
            return (
              <div className="space-y-2 rounded-md border p-3" key={direction}>
                <label className="block text-sm font-medium">
                  {direction === 'forward' ? 'Forward' : 'Inverse'} 저장 모델
                  <select
                    aria-label={`${direction} 저장 모델`}
                    className="mt-1 w-full rounded-md border bg-background p-2"
                    disabled={Boolean(working)}
                    value={selected ? `${selected.modelId}:${selected.modelRevision}` : ''}
                    onChange={(event) => {
                      const [id, revision] = event.target.value.split(':')
                      const model = models.find((item) => item.id === id)
                      const next = { ...setup.models }
                      if (model) next[direction] = savedModelReference(model, Number(revision))
                      else delete next[direction]
                      onChange({ ...setup, models: next })
                    }}
                  >
                    <option value="">저장 모델 선택</option>
                    {models
                      .filter(
                        (item) =>
                          item.direction === direction &&
                          item.launcher_id === setup.launcherId &&
                          item.state === 'active',
                      )
                      .flatMap((item) =>
                        item.revisions
                          .filter((entry) => entry.state === 'ready')
                          .map((entry) => (
                            <option key={`${item.id}:${entry.revision}`} value={`${item.id}:${entry.revision}`}>
                              {item.name} · r{entry.revision} · Dataset r{entry.dataset_revision}
                            </option>
                          )),
                      )}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(working) || !dataset || !setup.launcherId}
                    onClick={() =>
                      void run(`${direction} 모델 만들기`, (signal) => buildModel(direction, false, signal))
                    }
                  >
                    모델 만들기
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(working) || !dataset || !selected}
                    onClick={() =>
                      void run(`${direction} 모델 업데이트`, (signal) => buildModel(direction, true, signal))
                    }
                  >
                    모델 업데이트
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(working) || !selectedAsset}
                    onClick={() =>
                      selectedAsset && void run('모델 삭제', (signal) => deleteAsset('models', selectedAsset, signal))
                    }
                  >
                    모델 삭제
                  </Button>
                </div>
                {selected && (
                  <p className="text-xs break-all text-muted-foreground">
                    모델 {selected.modelId} · r{selected.modelRevision} / Dataset {selected.datasetId} · r
                    {selected.datasetRevision}
                  </p>
                )}
                {selected && (
                  <p className="text-xs text-muted-foreground">
                    파일 ·{' '}
                    {file
                      ? 'manifestChecksum' in file
                        ? '저장됨 (확인)'
                        : `사용 불가: ${file.error}`
                      : '장비에서 확인 필요'}{' '}
                    · 메모리 · {loadedDirections.includes(direction) ? '로드됨' : '로드되지 않음'}
                  </p>
                )}
              </div>
            )
          })}
          {models
            .filter((item) => item.state === 'deleting' && item.launcher_id === setup.launcherId)
            .map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="outline"
                disabled={Boolean(working)}
                onClick={() => void run('모델 삭제 재시도', (signal) => deleteAsset('models', item, signal))}
              >
                {item.name} 삭제 재시도
              </Button>
            ))}
          {working && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                operationRef.current?.abort()
                executionRef.current?.dispose()
                executionRef.current = null
              }}
            >
              작업 중단
            </Button>
          )}
          <p role="status" className="text-xs">
            {working
              ? `${working}…`
              : message ||
                'Dataset 동기화와 모델 업데이트는 각각 명시적으로 실행합니다. 유휴 5분 후 자원을 반환합니다.'}
          </p>
        </>
      )}
    </section>
  )
}
