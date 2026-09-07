import {
  isRayPathRecordedDataName,
  type RayPathBundle,
  type RecordedData,
  type RecordedDataRule,
} from '@/lib/cad/model'
import RecordedDataResults from '@/features/viewer/viewer/RecordedDataResults'
import { RayPathSystemCard } from '@/features/measurement/RayPathSystemCard'

export type RecordedDataEditorProps = {
  measurementId: number | null
  recordedAt?: string | null
  recordedData?: RecordedData | null
  rayPathBundles?: readonly RayPathBundle[]
  rayPathError?: string | null
  rayPathsDeclared?: boolean
  rules: readonly RecordedDataRule[]
}

export function RecordedDataEditor({
  measurementId,
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

  if (recordedAt === null) {
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
          <h2 className="text-sm font-semibold text-slate-800">RecordedData가 없습니다</h2>
        </div>
      </section>
    )
  }

  return results
}
