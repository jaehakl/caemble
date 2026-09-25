import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { dbTables, getListRequest } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCaeBatches } from '@/features/cae/CaeBatchProvider'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { Vars } from '@/lib/cad/model'
import { sampleMeasurementVars } from './measurementSpace'

export function BatchGenerationDialog({
  workbench,
  eligible,
  onClose,
}: {
  workbench: CaeWorkbenchState
  eligible: boolean
  onClose: () => void
}) {
  const [algorithm, setAlgorithm] = useState<'empty-lhs' | 'random'>('empty-lhs')
  const [count, setCount] = useState('10')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const pending = useRef<{ controller: AbortController; committed: boolean; submitted: boolean } | null>(null)
  const mounted = useRef(true)
  const cancel = useRef(workbench.measurementActions.cancel)
  cancel.current = workbench.measurementActions.cancel
  const { inspectBatch } = useCaeBatches()
  const numericCount = Number(count)
  const validCount = Number.isSafeInteger(numericCount) && numericCount > 0 && numericCount <= 100_000
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const request = pending.current
      if (request && !request.committed) {
        request.controller.abort()
        if (request.submitted) cancel.current()
      }
    }
  }, [])
  const close = () => {
    const request = pending.current
    if (request && !request.committed) {
      request.controller.abort()
      if (request.submitted) cancel.current()
      pending.current = null
    }
    onClose()
  }
  const submit = async () => {
    if (!eligible || !validCount || pending.current) return
    const schema = workbench.experimentDocument.varsSchema
    const experimentId = workbench.experimentId
    if (!schema || experimentId === null) return
    const request = { controller: new AbortController(), committed: false, submitted: false }
    pending.current = request
    setSubmitting(true)
    setError('')
    setFailures([])
    const { signal } = request.controller
    try {
      const existing = await dbTables.Measurement.listRows(
        {
          ...getListRequest('visible'),
          filter: { experiment_id: [experimentId, experimentId] },
          limit: null,
        },
        { signal, resolveObjects: false },
      )
      signal.throwIfAborted()
      const occupied = existing.items.map((row) => row.vars as Vars)
      if (!workbench.selection.measurement && workbench.candidateVars) occupied.push(workbench.candidateVars)
      const samples = sampleMeasurementVars(schema, occupied, numericCount, algorithm)
      request.submitted = true
      await workbench.measurementActions.runCandidatesAsync(
        {
          count: numericCount,
          algorithm: algorithm === 'empty-lhs' ? 'latin-hypercube' : 'monte-carlo',
          next: async (attempt, batchSignal) => {
            signal.throwIfAborted()
            batchSignal.throwIfAborted()
            return samples[attempt - 1]
          },
          accepted: async () => {},
          failed: (attempt, cause) => {
            if (mounted.current && !signal.aborted)
              setFailures((items) => [
                ...items,
                `${attempt}: ${cause instanceof Error ? cause.message : String(cause)}`,
              ])
          },
        },
        () => {},
        (batch) => {
          request.committed = true
          toast.success('일괄생성 Batch를 등록했습니다.', {
            description: `요청 ${numericCount}개 · 제출 ${batch.total}개 · 입력 준비 실패 ${numericCount - batch.total}개`,
            action: { label: '작업 보기', onClick: () => inspectBatch(batch.id) },
          })
          if (mounted.current) onClose()
        },
      )
    } catch (cause) {
      if (mounted.current && !signal.aborted && !request.committed)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (pending.current === request) pending.current = null
      if (mounted.current) setSubmitting(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="w-96">
        <DialogHeader>
          <DialogTitle>일괄생성</DialogTitle>
          <DialogDescription>샘플을 생성하여 하나의 Batch로 실행합니다.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="flex items-center justify-between gap-4 text-sm">
            알고리즘
            <select
              aria-label="알고리즘"
              value={algorithm}
              disabled={submitting}
              className="rounded border bg-background p-2"
              onChange={(event) => setAlgorithm(event.target.value as typeof algorithm)}
            >
              <option value="empty-lhs">LHS</option>
              <option value="random">Random</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">LHS는 기존 Measurement가 차지한 구간을 피하여 생성합니다.</p>
          <label className="flex items-center justify-between gap-4 text-sm">
            생성 개수
            <input
              aria-label="생성 개수"
              type="number"
              min={1}
              max={100_000}
              step={1}
              value={count}
              aria-invalid={!validCount}
              disabled={submitting}
              className="w-28 rounded border bg-background p-2"
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          {!validCount ? (
            <p role="alert" className="text-xs text-destructive">
              생성 개수는 1~100,000 사이의 정수여야 합니다.
            </p>
          ) : null}
          {submitting ? (
            <p role="status" className="text-xs">
              {workbench.measurementActions.stage || '샘플 준비 중…'}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {failures.length ? (
            <ul aria-label="입력 준비 실패" className="max-h-32 overflow-auto text-xs text-destructive">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              취소
            </Button>
            <Button type="submit" disabled={!eligible || !validCount || submitting}>
              실행
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
