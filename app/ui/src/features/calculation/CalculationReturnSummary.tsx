import type { CalculationPreviewState } from './CalculationOutputChart'

function summarizedData(data: number | readonly number[], shape: readonly number[]) {
  if (typeof data === 'number') return String(data)
  if (shape.length === 2) {
    const rows = shape[0] ?? 0
    const columns = shape[1] ?? 0
    if (rows === 0) return '[]'

    const rowIndexes = rows <= 4 ? Array.from({ length: rows }, (_, index) => index) : [0, 1, rows - 2, rows - 1]
    const columnsPerRow = Math.max(1, Math.floor(32 / rowIndexes.length))
    const leadingColumns = Math.ceil(columnsPerRow / 2)
    const trailingColumns = Math.floor(columnsPerRow / 2)
    const formattedRows = rowIndexes.map((rowIndex) => {
      const row = data.slice(rowIndex * columns, (rowIndex + 1) * columns)
      if (columns <= columnsPerRow) return `  [${row.join(', ')}]`
      return `  [${row.slice(0, leadingColumns).join(', ')}, … ${columns - columnsPerRow} columns omitted …, ${row.slice(-trailingColumns).join(', ')}]`
    })
    if (rows > 4) formattedRows.splice(2, 0, `  … ${rows - 4} rows omitted …`)
    return `[\n${formattedRows.join(',\n')}\n]`
  }
  if (data.length <= 32) return `[${data.join(', ')}]`
  return `[${data.slice(0, 16).join(', ')}, … ${data.length - 32} omitted …, ${data.slice(-16).join(', ')}]`
}

export function CalculationReturnSummary({ preview }: { preview: CalculationPreviewState }) {
  return (
    <section aria-label="Calculation Return 요약" className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="shrink-0 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-semibold">Return</h2>
        <p className="mt-0.5 text-[11px] text-zinc-400">정규화된 data 구조와 일부 값을 표시합니다.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {preview.status === 'success' ? (
          <div className="space-y-2">
            <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-zinc-300">
              <span className="text-zinc-500">dtype</span>
              <span>{preview.output.dtype}</span>
              <span className="text-zinc-500">shape</span>
              <span>{JSON.stringify(preview.output.shape)}</span>
            </div>
            <pre className="overflow-auto rounded border border-zinc-800 bg-black/30 p-2 whitespace-pre-wrap text-zinc-200">
              {summarizedData(preview.output.data, preview.output.shape)}
            </pre>
          </div>
        ) : preview.status === 'error' ? (
          <p className="text-zinc-400">Return을 만들지 못했습니다. 중앙 하단 Console에서 오류를 확인하세요.</p>
        ) : (
          <p className="text-zinc-500">{preview.message}</p>
        )}
      </div>
    </section>
  )
}
