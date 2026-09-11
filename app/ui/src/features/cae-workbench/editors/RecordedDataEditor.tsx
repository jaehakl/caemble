import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import type { RecordedResultContracts } from '@/contracts/results'
import { ResultTensorView } from '@/features/viewer/viewer/ResultTensorView'

export type RecordedDataEditorProps = {
  measurementId: number | null
  recordedAt?: string | null
  recordedData?: RecordedData | null
  resultContracts?: RecordedResultContracts | null
  rules: readonly RecordedDataRule[]
}

export function RecordedDataEditor({
  measurementId,
  recordedAt = null,
  recordedData,
  resultContracts,
  rules,
}: RecordedDataEditorProps) {
  const message =
    measurementId === null
      ? 'Measurement를 선택하세요'
      : recordedAt === null
        ? '실행되지 않은 Measurement입니다'
        : !resultContracts
          ? '이전 결과 계약은 새 Viewer에서 지원하지 않습니다.'
          : null
  if (message)
    return (
      <section className="grid h-full place-items-center p-8" aria-label="Recorded Data editor">
        {message}
      </section>
    )
  return (
    <section className="h-full overflow-auto">
      {Object.entries(resultContracts ?? {}).map(([name, contract]) => (
        <article key={name} className="border-b">
          <h3 className="p-3 text-sm">
            {name} · {contract.visualization.kind}
          </h3>
          <ResultTensorView name={name} contract={contract} rules={rules} data={recordedData} />
        </article>
      ))}
    </section>
  )
}
