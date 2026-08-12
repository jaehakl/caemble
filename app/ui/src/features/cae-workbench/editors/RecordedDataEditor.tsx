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
          <p className="mt-1 text-sm text-slate-500">
            Data 메뉴에서 Measurement를 선택하면 저장된 RecordedData를 표시합니다.
          </p>
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
          <p className="mt-1 text-sm text-slate-500">
            고정 입력 조건은 준비되어 있습니다. Run Selected를 실행하면 RecordedData가 한 번 기록됩니다.
          </p>
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
          <p className="mt-1 text-sm text-slate-500">
            {pendingSave
              ? '실행 결과는 현재 세션에 남아 있으며 재실행하지 않고 저장만 다시 시도할 수 있습니다.'
              : '선택한 Measurement에는 표시할 수 있는 저장 데이터가 없습니다.'}
          </p>
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
