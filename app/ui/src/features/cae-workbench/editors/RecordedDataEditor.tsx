import type { RecordedData, RecordedDataRule } from '@/lib/cad'
import RecordedDataResults from '@/features/viewer/viewer/RecordedDataResults'

export type RecordedDataEditorProps = {
  measurementId: number | null
  recordedData?: RecordedData | null
  rules: readonly RecordedDataRule[]
}

export function RecordedDataEditor({ measurementId, recordedData, rules }: RecordedDataEditorProps) {
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

  if (rules.length === 0) {
    return (
      <section
        aria-label="Recorded Data editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">RecordedData가 없습니다</h2>
          <p className="mt-1 text-sm text-slate-500">선택한 Measurement에는 표시할 수 있는 저장 데이터가 없습니다.</p>
        </div>
      </section>
    )
  }

  return <RecordedDataResults recordedData={recordedData} rules={rules} />
}
