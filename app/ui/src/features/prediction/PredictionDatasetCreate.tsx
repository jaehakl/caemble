import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SavedExperimentRecord } from '@caemble/execution/contracts/api/experiment'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { experimentDetailQueryOptions, experimentRecordsQueryOptions } from '@/features/experiment/queryOptions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PredictionAssetController } from './assetManagement'
import { PredictionDatasetImport } from './PredictionDatasetManager'

type Props = Readonly<{
  scope: PrivateQueryScope
  manager: PredictionAssetController
  experiments: readonly Pick<SavedExperimentRecord, 'id' | 'name'>[]
  experimentsError: Error | null
  onCreated: (id: string) => void
}>

export function PredictionDatasetCreate(props: Props) {
  const [experimentId, setExperimentId] = useState('')
  const selected = props.experiments.find((item) => String(item.id) === experimentId)
  return (
    <details className="rounded border p-3">
      <summary className="cursor-pointer font-medium">데이터셋 만들기·가져오기</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-sm">
          원본 Experiment
          <select
            aria-label="데이터셋 원본 Experiment"
            className="ml-2 max-w-full rounded border bg-background p-2"
            value={experimentId}
            onChange={(event) => setExperimentId(event.target.value)}
          >
            <option value="">내 Experiment 선택</option>
            {props.experiments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} (#{item.id})
              </option>
            ))}
          </select>
        </label>
        {props.experimentsError && (
          <p role="alert" className="text-sm text-destructive">
            Experiment 목록을 불러오지 못했습니다. {props.experimentsError.message}
          </p>
        )}
        {selected && <DatasetSourceForm key={selected.id} {...props} experimentId={selected.id} />}
      </div>
    </details>
  )
}

function DatasetSourceForm({
  scope,
  manager,
  experimentId,
  onCreated,
}: Pick<Props, 'scope' | 'manager' | 'onCreated'> & { experimentId: number }) {
  const experiment = useQuery(experimentDetailQueryOptions(scope, experimentId))
  const records = useQuery(experimentRecordsQueryOptions(scope, experimentId))
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [name, setName] = useState('')
  const [recordIds, setRecordIds] = useState<readonly number[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const task = state.tasks.find((item) => item.key === `dataset:create:${experimentId}`)
  const pending = submitting || task?.state === 'running'
  const failure =
    experiment.error?.message ?? records.error?.message ?? error ?? (task?.state === 'failed' ? task.message : null)
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        저장된 Experiment의 Measurement·RecordedData를 학습 데이터로 보관합니다. 모델 학습은 별도로 시작합니다.
      </p>
      {(experiment.isPending || records.isPending) && <p role="status">Experiment와 Record를 불러오는 중…</p>}
      {failure && (
        <p role="alert" className="text-sm whitespace-pre-line text-destructive">
          {failure}
        </p>
      )}
      {task?.state === 'running' && (
        <p role="status" className="text-sm">
          {task.message}
        </p>
      )}
      <label className="block text-sm">
        새 데이터셋 이름
        <Input
          aria-label="새 데이터셋 이름"
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="space-y-1 text-sm">
        <legend>포함할 Record</legend>
        {records.data?.items.map((record) => (
          <label key={record.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={recordIds.includes(record.id)}
              onChange={(event) =>
                setRecordIds((previous) =>
                  event.target.checked ? [...previous, record.id] : previous.filter((id) => id !== record.id),
                )
              }
            />
            {record.name}
          </label>
        ))}
        {records.data && !records.data.items.length && <p>저장된 Record가 없습니다.</p>}
      </fieldset>
      <Button
        size="sm"
        disabled={
          pending ||
          !name.trim() ||
          !recordIds.length ||
          !experiment.data ||
          !records.data ||
          experiment.isError ||
          records.isError
        }
        onClick={async () => {
          if (!experiment.data || !records.data) return
          setSubmitting(true)
          setError(null)
          const input = { experiment: experiment.data, records: records.data.items, recordIds, name }
          try {
            const { createStandaloneDataset } = await import('./datasetCreation')
            const dataset = await createStandaloneDataset(manager, input)
            if (dataset && mounted.current) onCreated(dataset.id)
          } catch (cause) {
            if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            if (mounted.current) setSubmitting(false)
          }
        }}
      >
        {pending ? '데이터셋 만드는 중…' : '데이터셋 만들기'}
      </Button>
      <PredictionDatasetImport manager={manager} experimentId={experimentId} onImported={onCreated} />
    </div>
  )
}
