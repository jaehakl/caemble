import type { ReactNode } from 'react'
import type { UcumUnit } from '@/lib/cad/model'

function heatmapColor(value: number, minimum: number, maximum: number) {
  const ratio = maximum === minimum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))
  const hue = 260 - ratio * 210
  const lightness = 28 + ratio * 34
  return `hsl(${hue} 78% ${lightness}%)`
}

export function Heatmap({
  columnTicks,
  fillContainer = false,
  getValue,
  preserveTensorAspect = false,
  resultUnit,
  rowTicks,
  tickSignificantDigits,
  xTitle,
  yTitle,
}: {
  columnTicks: readonly (number | string)[]
  fillContainer?: boolean
  getValue: (rowIndex: number, columnIndex: number) => number
  preserveTensorAspect?: boolean
  resultUnit: UcumUnit | undefined
  rowTicks: readonly (number | string)[]
  tickSignificantDigits?: number
  xTitle: string
  yTitle: string
}) {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  rowTicks.forEach((_row, rowIndex) =>
    columnTicks.forEach((_column, columnIndex) => {
      const value = getValue(rowIndex, columnIndex)
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }),
  )
  const maximumWidth = 680
  const maximumHeight = 236
  const tensorAspect = columnTicks.length / rowTicks.length
  const width = preserveTensorAspect ? Math.min(maximumWidth, maximumHeight * tensorAspect) : maximumWidth
  const height = preserveTensorAspect ? Math.min(maximumHeight, maximumWidth / tensorAspect) : maximumHeight
  const left = fillContainer ? 64 : 72 + (maximumWidth - width) / 2
  const top = fillContainer ? 20 : 20 + (maximumHeight - height) / 2
  const viewBox = fillContainer ? `0 0 ${64 + width + 52} ${20 + height + 64}` : '0 0 800 320'
  const cellWidth = width / columnTicks.length
  const cellHeight = height / rowTicks.length
  const columnStep = fillContainer
    ? Math.max(1, Math.ceil((columnTicks.length - 1) / 3))
    : Math.max(1, Math.ceil(columnTicks.length / 8))
  const rowStep = Math.max(1, Math.ceil(rowTicks.length / 6))
  const columnLabelIndices: number[] = []
  for (let index = 0; index < columnTicks.length; index += columnStep) columnLabelIndices.push(index)
  if (columnLabelIndices[columnLabelIndices.length - 1] !== columnTicks.length - 1) {
    columnLabelIndices.push(columnTicks.length - 1)
  }
  const rowLabelIndices: number[] = []
  for (let index = 0; index < rowTicks.length; index += rowStep) rowLabelIndices.push(index)
  if (rowLabelIndices[rowLabelIndices.length - 1] !== rowTicks.length - 1) rowLabelIndices.push(rowTicks.length - 1)
  const rowStride = Math.max(1, Math.ceil(rowTicks.length / 100))
  const renderedRowCount = Math.ceil(rowTicks.length / rowStride)
  const columnStride = Math.max(1, Math.ceil((columnTicks.length * renderedRowCount) / 10_000))
  const cells: ReactNode[] = []
  for (let rowIndex = 0; rowIndex < rowTicks.length; rowIndex += rowStride) {
    for (let columnIndex = 0; columnIndex < columnTicks.length; columnIndex += columnStride) {
      const value = getValue(rowIndex, columnIndex)
      cells.push(
        <rect
          fill={heatmapColor(value, minimum, maximum)}
          height={Math.min(rowStride, rowTicks.length - rowIndex) * cellHeight + 0.25}
          key={`${rowIndex}-${columnIndex}`}
          width={Math.min(columnStride, columnTicks.length - columnIndex) * cellWidth + 0.25}
          x={left + columnIndex * cellWidth}
          y={top + rowIndex * cellHeight}
        >
          <title>{`${String(rowTicks[rowIndex])}, ${String(columnTicks[columnIndex])}: ${value} ${resultUnit ?? 'unitless'}`}</title>
        </rect>,
      )
    }
  }

  return (
    <div
      className={`${fillContainer ? 'h-full min-h-0' : 'h-80'} w-full overflow-hidden rounded border border-slate-200 bg-white`}
      data-result-visualization="heatmap"
    >
      <svg
        aria-label="Recorded heatmap"
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={viewBox}
      >
        {cells}
        {columnLabelIndices.map((index) => (
          <text
            fill="#64748b"
            fontSize="10"
            key={index}
            textAnchor="middle"
            x={left + (index + 0.5) * cellWidth}
            y={top + height + 18}
          >
            {typeof columnTicks[index] === 'number' && tickSignificantDigits !== undefined
              ? String(Number(columnTicks[index].toPrecision(tickSignificantDigits)))
              : String(columnTicks[index])}
          </text>
        ))}
        {rowLabelIndices.map((index) => (
          <text
            fill="#64748b"
            fontSize="10"
            key={index}
            textAnchor="end"
            x={left - 7}
            y={top + (index + 0.65) * cellHeight}
          >
            {typeof rowTicks[index] === 'number' && tickSignificantDigits !== undefined
              ? String(Number(rowTicks[index].toPrecision(tickSignificantDigits)))
              : String(rowTicks[index])}
          </text>
        ))}
        <text fill="#475569" fontSize="11" textAnchor="middle" x={left + width / 2} y={top + height + 51}>
          {xTitle}
        </text>
        <text
          fill="#475569"
          fontSize="11"
          textAnchor="middle"
          transform={`rotate(-90 ${Math.max(8, left - 56)} ${top + height / 2})`}
          x={Math.max(8, left - 56)}
          y={top + height / 2}
        >
          {yTitle}
        </text>
        <text fill="#64748b" fontSize="10" x={fillContainer ? left + width + 8 : 758} y={top + 10}>
          {maximum.toPrecision(4)}
        </text>
        <text fill="#64748b" fontSize="10" x={fillContainer ? left + width + 8 : 758} y={top + height}>
          {minimum.toPrecision(4)}
        </text>
      </svg>
    </div>
  )
}
