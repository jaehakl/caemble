import { isRayPathRecordedDataName, type RayPathBundle, type RecordedData, type RecordedDataRule } from '@/lib/cad'
import RecordedDataResults from '@/features/viewer/viewer/RecordedDataResults'
import { RayPathSystemCard } from '../measurement/RayPathSystemCard'

export type RecordedDataEditorProps = {
  measurementId: number | null
  pendingSave?: boolean
  recordedAt?: string | null
  recordedData?: RecordedData | null
  rayPathBundles?: readonly RayPathBundle[]
  rayPathError?: string | null
  rayPathsDeclared?: boolean
  rules: readonly RecordedDataRule[]
}

export function RecordedDataEditor({
  measurementId,
  pendingSave = false,
  recordedAt = null,
  recordedData,
  rayPathBundles = [],
  rayPathError = null,
  rayPathsDeclared = false,
  rules,
}: RecordedDataEditorProps) {
  const regularRules = rules.filter((rule) => !isRayPathRecordedDataName(rule.label))
  const regularRecordedData = recordedData
    ? (Object.freeze(
        Object.fromEntries(Object.entries(recordedData).filter(([name]) => !isRayPathRecordedDataName(name))),
      ) as RecordedData)
    : recordedData
  const regularResults =
    regularRules.length > 0 ? <RecordedDataResults recordedData={regularRecordedData} rules={regularRules} /> : null
  const results =
    rayPathsDeclared || rayPathBundles.length > 0 || rayPathError ? (
      <div className="h-full min-h-0 space-y-3 overflow-y-auto p-3">
        <RayPathSystemCard bundles={rayPathBundles} declared={rayPathsDeclared} error={rayPathError} />
        {regularResults}
      </div>
    ) : (
      regularResults
    )
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

  if (regularRules.length === 0 && !rayPathsDeclared && rayPathBundles.length === 0 && !rayPathError) {
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
      <div className="min-h-0 flex-1">{results}</div>
    </section>
  ) : (
    results
  )
}
