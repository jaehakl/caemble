import type { RecordedData, RecordedDataRule } from '@/lib/cad'
import RecordedDataResults from '@/features/viewer/viewer/RecordedDataResults'

export type RecordedDataEditorProps = {
  measurementId: number | null
  pendingSave?: boolean
  recordedAt?: string | null
  recordedData?: RecordedData | null
  rules: readonly RecordedDataRule[]
}

export function RecordedDataEditor({
  measurementId,
  pendingSave = false,
  recordedAt = null,
  recordedData,
  rules,
}: RecordedDataEditorProps) {
  if (measurementId === null) {
    return (
      <section
        aria-label="Recorded Data editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Measurement를 선택하세요</h2>
        </div>
      </section>
    )
  }

  if (!pendingSave && recordedAt === null) {
    return (
      <section
        aria-label="Recorded Data editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">실행되지 않은 Measurement입니다</h2>
        </div>
      </section>
    )
  }

  if (rules.length === 0) {
    return (
      <section
        aria-label="Recorded Data editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            {pendingSave ? '세션 결과 저장을 다시 시도하세요' : 'RecordedData가 없습니다'}
          </h2>
        </div>
      </section>
    )
  }

  return pendingSave ? (
    <section className="flex h-full min-h-0 flex-col bg-slate-50">
      <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950" role="alert">
        실행 결과는 이 세션에 남아 있습니다. 재실행하지 말고 <strong>Retry Saving Results</strong>로 저장만 다시
        시도하세요.
      </div>
      <div className="min-h-0 flex-1">
        <RecordedDataResults recordedData={recordedData} rules={rules} />
      </div>
    </section>
  ) : (
    <RecordedDataResults recordedData={recordedData} rules={rules} />
  )
}
