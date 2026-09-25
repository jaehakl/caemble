import { Plus, Sparkles, Play, Square } from 'lucide-react'
import { WorkbenchRibbonButton, WorkbenchRibbonGroup } from '@/features/cae-workbench/chrome/WorkbenchRibbon'
import type { MeasurementSession } from './useMeasurementSession'

export function MeasurementSamplingControls({ session }: { session: MeasurementSession }) {
  return (
    <WorkbenchRibbonGroup label="샘플 생성">
      <div className="flex h-[72px] flex-col justify-center gap-1">
        <select
          aria-label="샘플 생성 방식"
          className="h-6 rounded-sm border border-border bg-background px-2 text-xs"
          value={session.algorithm}
          disabled={session.busy}
          onChange={(event) => session.setAlgorithm(event.target.value as typeof session.algorithm)}
        >
          <option value="random">Random</option>
          <option value="empty-lhs">빈 구간 LHS</option>
        </select>
        <input
          aria-label="샘플 생성 개수 N"
          className="h-6 w-20 rounded-sm border border-border bg-background px-2 text-xs"
          type="number"
          min={1}
          step={1}
          value={session.count}
          disabled={session.busy}
          onChange={(event) => session.setCount(event.target.value)}
        />
      </div>
      <WorkbenchRibbonButton
        size="large"
        icon={<Sparkles />}
        label="샘플 생성"
        disabled={!session.schema || session.busy || !session.valid || session.query.isFetching}
        onClick={session.generate}
      />
      <div className="grid h-[72px] grid-rows-3 items-center">
        <WorkbenchRibbonButton
          icon={<Plus />}
          label="샘플 추가"
          disabled={!session.vars || session.busy || !session.valid}
          onClick={session.addCandidate}
        />
      </div>
    </WorkbenchRibbonGroup>
  )
}

export function MeasurementBatchControls({ session }: { session: MeasurementSession }) {
  return (
    <WorkbenchRibbonGroup label="전체 실행">
      {session.running ? (
        <WorkbenchRibbonButton size="large" icon={<Square />} label="전체 실행 취소" onClick={session.cancel} />
      ) : (
        <WorkbenchRibbonButton
          size="large"
          icon={<Play />}
          label="전체 실행"
          disabled={
            !session.persistable ||
            !session.ready ||
            !session.valid ||
            session.busy ||
            (!session.candidates.length && session.currentId !== 'draft')
          }
          onClick={() => void session.run(true)}
        />
      )}
      <span role="status" className="max-w-44 text-xs text-muted-foreground">
        {session.operation}
      </span>
    </WorkbenchRibbonGroup>
  )
}
