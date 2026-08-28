import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { catalogApi } from '@/api/catalog'
import { convertUcumValue, type RecordedDataRule, type UcumUnit } from '@/lib/cad'
import { identityCartesianBasis } from '@/lib/quantitykind'
import {
  convertRecordedNumericTicks,
  isNumericRecordedDType,
  readRecordedValue,
  recordedDisplayUnitOptions,
  resolveCadViewerRecordedData,
  type CadViewerRecordedData,
  type RecordedDataDisplayUnits,
  type RecordedDataDisplayUnitTarget,
  type RecordedQuantityKinds,
  type ResolvedRecordedTensor,
} from './recordedData'
import { componentIndexPaths, componentLabel } from './recordedComponents'

type RecordedDataResultsProps = {
  displayUnits?: RecordedDataDisplayUnits
  onDisplayUnitChange?: (label: string, target: RecordedDataDisplayUnitTarget, unit: UcumUnit) => void
  quantityKinds?: RecordedQuantityKinds
  recordedData?: CadViewerRecordedData | null
  rules: readonly RecordedDataRule[]
}

function schemaAxis(rule: RecordedDataRule, axisIndex: number) {
  return {
    length: rule.result.axes?.[axisIndex]?.length,
    name: rule.result.axes?.[axisIndex]?.name ?? `axis ${axisIndex}`,
    quantityKind: rule.result.axes?.[axisIndex]?.quantityKind,
    ticks: rule.result.axes?.[axisIndex]?.ticks,
    unit: rule.result.axes?.[axisIndex]?.unit,
  }
}

function unitLabel(unit: string | undefined) {
  return unit ?? 'unitless'
}

function axisTitle(rule: RecordedDataRule, axisIndex: number, axisUnits?: readonly (UcumUnit | undefined)[]) {
  const axis = schemaAxis(rule, axisIndex)
  return `${axis.name} (${unitLabel(axisUnits?.[axisIndex] ?? axis.unit)})`
}

function visualizationKind(rule: RecordedDataRule) {
  const axisCount = rule.result.axes?.length ?? 0
  if (axisCount === 0) return 'scalar'
  if (!isNumericRecordedDType(rule.result.dtype)) return 'table'
  return axisCount === 1 ? 'line chart' : 'heatmap'
}

function EmptyPlot({ axisUnits, rule }: { axisUnits: readonly (UcumUnit | undefined)[]; rule: RecordedDataRule }) {
  const kind = visualizationKind(rule)
  const axisCount = rule.result.axes?.length ?? 0
  return (
    <div
      aria-label={`${rule.label} empty ${kind}`}
      className="relative grid min-h-56 place-items-center overflow-hidden rounded border border-dashed border-slate-300 bg-slate-50"
      data-result-visualization={kind}
    >
      <div className="absolute inset-x-4 bottom-3 truncate text-center text-[10px] text-slate-400">
        {axisCount === 0 ? 'scalar result' : axisTitle(rule, axisCount - 1, axisUnits)}
      </div>
      {axisCount >= 2 ? (
        <div className="absolute top-2 bottom-8 left-2 flex items-center text-[10px] text-slate-400 [writing-mode:vertical-rl]">
          {axisTitle(rule, axisCount - 2, axisUnits)}
        </div>
      ) : null}
      <div className="text-center">
        <div className="text-sm font-semibold text-slate-500">No recorded data</div>
        <div className="mt-1 text-xs text-slate-400">
          Empty {kind} · expected axis lengths{' '}
          {JSON.stringify(rule.result.axes?.map((axis) => axis.length ?? 'dynamic') ?? [])}
        </div>
      </div>
    </div>
  )
}

function numericExtent(values: readonly number[]) {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  values.forEach((value) => {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  })
  return minimum === maximum ? { minimum: minimum - 0.5, maximum: maximum + 0.5 } : { minimum, maximum }
}

export function LineChart({
  resultUnit,
  ticks,
  values,
  xTitle,
}: {
  resultUnit: UcumUnit | undefined
  ticks: readonly (number | string)[]
  values: readonly number[]
  xTitle: string
}) {
  const { minimum, maximum } = numericExtent(values)
  const left = 72
  const top = 20
  const width = 704
  const height = 236
  const pointStep = Math.max(1, Math.ceil(values.length / 5_000))
  const pointIndices: number[] = []
  for (let index = 0; index < values.length; index += pointStep) pointIndices.push(index)
  if (pointIndices[pointIndices.length - 1] !== values.length - 1) pointIndices.push(values.length - 1)
  const points = pointIndices.map((index) => {
    const value = values[index]
    const x = left + (values.length === 1 ? width / 2 : (index * width) / (values.length - 1))
    const y = top + ((maximum - value) * height) / (maximum - minimum)
    return { index, value, x, y }
  })
  const tickStep = Math.max(1, Math.ceil(ticks.length / 8))
  const tickIndices: number[] = []
  for (let index = 0; index < ticks.length; index += tickStep) tickIndices.push(index)
  if (tickIndices[tickIndices.length - 1] !== ticks.length - 1) tickIndices.push(ticks.length - 1)

  return (
    <div
      className="h-80 w-full overflow-hidden rounded border border-slate-200 bg-white"
      data-result-visualization="line chart"
    >
      <svg aria-label="Recorded line chart" className="h-full w-full" role="img" viewBox="0 0 800 320">
        <rect fill="#f8fafc" height={height} width={width} x={left} y={top} />
        <line stroke="#94a3b8" x1={left} x2={left} y1={top} y2={top + height} />
        <line stroke="#94a3b8" x1={left} x2={left + width} y1={top + height} y2={top + height} />
        <polyline
          fill="none"
          points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
          stroke="#2563eb"
          strokeWidth="2"
        />
        {points.map(({ index, value, x, y }) => (
          <circle cx={x} cy={y} fill="#2563eb" key={index} r="3">
            <title>{`${String(ticks[index])}: ${value} ${unitLabel(resultUnit)}`}</title>
          </circle>
        ))}
        {tickIndices.map((index) => (
          <text
            fill="#64748b"
            fontSize="10"
            key={index}
            textAnchor="middle"
            x={left + (ticks.length === 1 ? width / 2 : (index * width) / (ticks.length - 1))}
            y={top + height + 18}
          >
            {String(ticks[index])}
          </text>
        ))}
        <text fill="#475569" fontSize="11" textAnchor="middle" x={left + width / 2} y="307">
          {xTitle}
        </text>
        <text fill="#475569" fontSize="11" textAnchor="middle" transform="rotate(-90 16 138)" x="16" y="138">
          Value ({unitLabel(resultUnit)})
        </text>
        <text fill="#64748b" fontSize="10" textAnchor="end" x={left - 8} y={top + 4}>
          {maximum.toPrecision(4)}
        </text>
        <text fill="#64748b" fontSize="10" textAnchor="end" x={left - 8} y={top + height}>
          {minimum.toPrecision(4)}
        </text>
      </svg>
    </div>
  )
}

function heatmapColor(value: number, minimum: number, maximum: number) {
  const ratio = maximum === minimum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))
  const hue = 260 - ratio * 210
  const lightness = 28 + ratio * 34
  return `hsl(${hue} 78% ${lightness}%)`
}

export function Heatmap({
  columnTicks,
  getValue,
  resultUnit,
  rowTicks,
  xTitle,
  yTitle,
}: {
  columnTicks: readonly (number | string)[]
  getValue: (rowIndex: number, columnIndex: number) => number
  resultUnit: UcumUnit | undefined
  rowTicks: readonly (number | string)[]
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
  const left = 72
  const top = 20
  const width = 680
  const height = 236
  const cellWidth = width / columnTicks.length
  const cellHeight = height / rowTicks.length
  const columnStep = Math.max(1, Math.ceil(columnTicks.length / 8))
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
          <title>{`${String(rowTicks[rowIndex])}, ${String(columnTicks[columnIndex])}: ${value} ${unitLabel(resultUnit)}`}</title>
        </rect>,
      )
    }
  }

  return (
    <div
      className="h-80 w-full overflow-hidden rounded border border-slate-200 bg-white"
      data-result-visualization="heatmap"
    >
      <svg aria-label="Recorded heatmap" className="h-full w-full" role="img" viewBox="0 0 800 320">
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
            {String(columnTicks[index])}
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
            {String(rowTicks[index])}
          </text>
        ))}
        <text fill="#475569" fontSize="11" textAnchor="middle" x={left + width / 2} y="307">
          {xTitle}
        </text>
        <text fill="#475569" fontSize="11" textAnchor="middle" transform="rotate(-90 16 138)" x="16" y="138">
          {yTitle}
        </text>
        <text fill="#64748b" fontSize="10" x="758" y={top + 10}>
          {maximum.toPrecision(4)}
        </text>
        <text fill="#64748b" fontSize="10" x="758" y={top + height}>
          {minimum.toPrecision(4)}
        </text>
      </svg>
    </div>
  )
}

function MatrixTable({
  axisUnits,
  getValue,
  resultUnit,
  rule,
  tensor,
}: {
  axisUnits: readonly (UcumUnit | undefined)[]
  getValue: (rowIndex: number, columnIndex?: number) => boolean | string | number
  resultUnit: UcumUnit | undefined
  rule: RecordedDataRule
  tensor: ResolvedRecordedTensor
}) {
  if (tensor.axes.length === 1) {
    const axis = tensor.axes[0]
    return (
      <div className="max-h-80 overflow-auto rounded border border-slate-200">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-slate-100 text-slate-600">
            <tr>
              <th className="px-3 py-2">{axisTitle(rule, 0, axisUnits)}</th>
              <th className="px-3 py-2">Value ({unitLabel(resultUnit)})</th>
            </tr>
          </thead>
          <tbody>
            {axis.ticks.map((_tick, index) => (
              <tr className="border-t border-slate-100" key={index}>
                <td className="px-3 py-2">{String(axis.ticks[index])}</td>
                <td className="px-3 py-2 font-mono">{String(getValue(index))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const rowAxis = tensor.axes[tensor.axes.length - 2]
  const columnAxis = tensor.axes[tensor.axes.length - 1]
  return (
    <div className="max-h-80 overflow-auto rounded border border-slate-200">
      <table className="min-w-full border-collapse text-center text-xs">
        <thead className="sticky top-0 bg-slate-100 text-slate-600">
          <tr>
            <th className="px-3 py-2">
              {axisTitle(rule, tensor.axes.length - 2, axisUnits)} /{' '}
              {axisTitle(rule, tensor.axes.length - 1, axisUnits)}
            </th>
            {columnAxis.ticks.map((tick, index) => (
              <th className="px-3 py-2" key={index}>
                {String(tick)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowAxis.ticks.map((_tick, rowIndex) => (
            <tr className="border-t border-slate-100" key={rowIndex}>
              <th className="sticky left-0 bg-white px-3 py-2 text-slate-600">{String(rowAxis.ticks[rowIndex])}</th>
              {columnAxis.ticks.map((_columnTick, columnIndex) => (
                <td className="px-3 py-2 font-mono" key={columnIndex}>
                  {String(getValue(rowIndex, columnIndex))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TensorVisualization({
  axisUnits,
  componentSelection,
  resultUnit,
  rule,
  sourceUnit,
  tensor,
}: {
  axisUnits: readonly (UcumUnit | undefined)[]
  componentSelection: string
  resultUnit: UcumUnit | undefined
  rule: RecordedDataRule
  sourceUnit: UcumUnit | undefined
  tensor: ResolvedRecordedTensor
}) {
  const leadingAxisCount = Math.max(0, tensor.axes.length - 2)
  const [sliceIndices, setSliceIndices] = useState(() => Array.from({ length: leadingAxisCount }, () => 0))
  const safeIndices = sliceIndices.map((index, axisIndex) =>
    Math.min(index, Math.max(0, tensor.axes[axisIndex].length - 1)),
  )
  const readValue = (outerIndices: readonly number[]) => {
    const value = readRecordedValue(tensor, outerIndices, componentSelection)
    return typeof value === 'number' && sourceUnit && resultUnit && sourceUnit !== resultUnit
      ? convertUcumValue(value, sourceUnit, resultUnit, 'Recorded value display unit')
      : value
  }

  if (tensor.axes.length === 0) {
    const value = readValue([])
    return (
      <div
        aria-label="Recorded scalar value"
        className="flex min-h-32 items-baseline justify-center gap-2 rounded border border-slate-200 bg-slate-50 font-mono text-3xl text-slate-900"
        data-result-visualization="scalar"
      >
        <span>{String(value)}</span>
        <span className="text-base text-slate-500">{unitLabel(resultUnit)}</span>
      </div>
    )
  }

  if (tensor.axes.some((axis) => axis.length === 0)) {
    return (
      <div className="grid min-h-56 place-items-center rounded border border-dashed border-slate-300 bg-slate-50 text-center">
        <div>
          <div className="text-sm font-semibold text-slate-500">No recorded values</div>
          <div className="mt-1 text-xs text-slate-400">
            Resolved empty data · actual axis lengths {JSON.stringify(tensor.axes.map((axis) => axis.length))}
          </div>
        </div>
      </div>
    )
  }

  const controls =
    leadingAxisCount > 0 ? (
      <div className="mb-3 flex flex-wrap gap-3">
        {Array.from({ length: leadingAxisCount }, (_, axisIndex) => {
          const axis = tensor.axes[axisIndex]
          return (
            <label className="text-xs font-medium text-slate-600" key={axisIndex}>
              <span className="mr-2">{axisTitle(rule, axisIndex, axisUnits)}</span>
              <select
                aria-label={`Select ${axis.name} slice`}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                disabled={axis.ticks.length === 0}
                value={safeIndices[axisIndex] ?? 0}
                onChange={(event) =>
                  setSliceIndices((current) =>
                    current.map((index, indexAxis) => (indexAxis === axisIndex ? Number(event.target.value) : index)),
                  )
                }
              >
                {axis.ticks.length === 0 ? <option value={0}>No values</option> : null}
                {axis.ticks.map((tick, index) => (
                  <option key={index} value={index}>
                    {index}: {String(tick)}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
    ) : null

  if (!isNumericRecordedDType(tensor.dtype)) {
    const getValue = (rowIndex: number, columnIndex?: number) =>
      readValue([...safeIndices, rowIndex, ...(columnIndex === undefined ? [] : [columnIndex])])
    return (
      <>
        {controls}
        <MatrixTable axisUnits={axisUnits} getValue={getValue} resultUnit={resultUnit} rule={rule} tensor={tensor} />
      </>
    )
  }

  if (tensor.axes.length === 1) {
    const axis = tensor.axes[0]
    const values = Array.from({ length: axis.length }, (_, index) => readValue([index]) as number)
    return (
      <LineChart resultUnit={resultUnit} ticks={axis.ticks} values={values} xTitle={axisTitle(rule, 0, axisUnits)} />
    )
  }

  const rowAxis = tensor.axes[tensor.axes.length - 2]
  const columnAxis = tensor.axes[tensor.axes.length - 1]
  return (
    <>
      {controls}
      <Heatmap
        columnTicks={columnAxis.ticks}
        getValue={(rowIndex, columnIndex) => readValue([...safeIndices, rowIndex, columnIndex]) as number}
        resultUnit={resultUnit}
        rowTicks={rowAxis.ticks}
        xTitle={axisTitle(rule, tensor.axes.length - 1, axisUnits)}
        yTitle={axisTitle(rule, tensor.axes.length - 2, axisUnits)}
      />
    </>
  )
}

function RecordedResultCard({
  displayUnits,
  entry,
  onDisplayUnitChange,
  quantityKinds,
}: {
  displayUnits: RecordedDataDisplayUnits[string] | undefined
  entry: ReturnType<typeof resolveCadViewerRecordedData>['entries'][number]
  onDisplayUnitChange: RecordedDataResultsProps['onDisplayUnitChange']
  quantityKinds: RecordedQuantityKinds
}) {
  const { error, rule, tensor } = entry
  const quantityKind = rule.result.quantityKind ? quantityKinds.get(rule.result.quantityKind) : undefined
  const tensorOrder = quantityKind?.tensorOrder ?? 0
  const componentShape = Object.freeze(Array.from({ length: tensorOrder }, () => 3 as const))
  const componentOptions = componentIndexPaths(tensorOrder)
  const identityBasis = JSON.stringify(rule.result.basis) === JSON.stringify(identityCartesianBasis)
  const [componentSelection, setComponentSelection] = useState('norm')
  const display = useMemo(() => {
    const conversionErrors: string[] = []
    const resultUnitOptions =
      quantityKind && rule.result.unit ? recordedDisplayUnitOptions(quantityKind, rule.result.unit) : []
    const requestedResultUnit =
      displayUnits?.result && resultUnitOptions.includes(displayUnits.result) ? displayUnits.result : rule.result.unit
    let resultUnit = requestedResultUnit

    if (tensor && rule.result.unit && requestedResultUnit && requestedResultUnit !== rule.result.unit) {
      try {
        convertUcumValue(1, rule.result.unit, requestedResultUnit, 'Recorded value display unit')
        if (
          tensor.tensorOrder > 0 &&
          convertUcumValue(0, rule.result.unit, requestedResultUnit, 'Recorded value display unit') !== 0
        ) {
          throw new Error('Recorded tensor display unit conversion must preserve zero.')
        }
      } catch (conversionError) {
        resultUnit = rule.result.unit
        conversionErrors.push(
          `Result ${rule.result.unit} → ${requestedResultUnit}: ${conversionError instanceof Error ? conversionError.message : String(conversionError)}`,
        )
      }
    }

    const axes = Array.from({ length: rule.result.axes?.length ?? 0 }, (_, axisIndex) => {
      const axis = schemaAxis(rule, axisIndex)
      const sourceTicks = tensor?.axes[axisIndex].ticks ?? axis.ticks
      const numericTicks =
        sourceTicks !== undefined && sourceTicks.length > 0 && sourceTicks.every((tick) => typeof tick === 'number')
      const axisQuantityKind = axis.quantityKind ? quantityKinds.get(axis.quantityKind) : undefined
      const unitOptions =
        numericTicks && axisQuantityKind && axis.unit ? recordedDisplayUnitOptions(axisQuantityKind, axis.unit) : []
      const selectedUnit = displayUnits?.axes?.[axisIndex]
      const requestedUnit = selectedUnit && unitOptions.includes(selectedUnit) ? selectedUnit : axis.unit
      let ticks = sourceTicks
      let unit = requestedUnit

      if (numericTicks && axis.unit && requestedUnit && requestedUnit !== axis.unit) {
        try {
          ticks = convertRecordedNumericTicks(sourceTicks as readonly number[], axis.unit, requestedUnit)
        } catch (conversionError) {
          ticks = sourceTicks
          unit = axis.unit
          conversionErrors.push(
            `${axis.name} axis ${axis.unit} → ${requestedUnit}: ${conversionError instanceof Error ? conversionError.message : String(conversionError)}`,
          )
        }
      }

      return { ...axis, ticks, unit, unitOptions }
    })
    const displayedTensor = tensor
      ? (Object.freeze(
          Object.defineProperty(
            {
              accessor: tensor.accessor,
              axes: Object.freeze(
                tensor.axes.map((axis, axisIndex) =>
                  Object.freeze({
                    ...axis,
                    ticks: axes[axisIndex].ticks ?? axis.ticks,
                  }),
                ),
              ),
              componentShape: tensor.componentShape,
              tensorOrder: tensor.tensorOrder,
              dtype: tensor.dtype,
              ...(tensor.unit === undefined ? {} : { unit: tensor.unit }),
              ...(tensor.quantityKind === undefined ? {} : { quantityKind: tensor.quantityKind }),
              ...(tensor.basis === undefined ? {} : { basis: tensor.basis }),
            },
            'value',
            { get: () => tensor.value },
          ),
        ) as ResolvedRecordedTensor)
      : null

    return {
      axes,
      axisUnits: axes.map((axis) => axis.unit),
      conversionErrors,
      resultUnit,
      resultUnitOptions,
      tensor: displayedTensor,
    }
  }, [displayUnits, quantityKind, quantityKinds, rule, tensor])

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{rule.label}</h3>
          <p className="mt-1 font-mono text-xs text-slate-500">{rule.methodId}</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right text-xs text-slate-500">
          <div className="font-mono">
            <div>
              {rule.result.dtype} · axes{' '}
              {rule.result.axes?.map((axis) => axis.length ?? 'dynamic').join(' × ') ?? 'none'} ·{' '}
              {unitLabel(display.resultUnit)}
            </div>
            <div>
              tensor order {tensorOrder} · components {JSON.stringify(componentShape)}
            </div>
            {rule.result.basis ? <div>basis {JSON.stringify(rule.result.basis)}</div> : null}
            {tensor ? <div>actual axis lengths {JSON.stringify(tensor.axes.map((axis) => axis.length))}</div> : null}
          </div>
          {display.resultUnit && display.resultUnitOptions.length > 0 ? (
            <label className="flex items-center gap-2 font-medium text-slate-600">
              <span>Result unit</span>
              <select
                aria-label={`${rule.label} result display unit`}
                className="max-w-48 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800"
                value={display.resultUnit}
                onChange={(event) => onDisplayUnitChange?.(rule.label, 'result', event.target.value)}
              >
                {display.resultUnitOptions.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {tensorOrder > 0 ? (
        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-600">
          <span>Displayed component</span>
          <select
            aria-label={`${rule.label} component`}
            className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800"
            value={componentSelection}
            onChange={(event) => setComponentSelection(event.target.value)}
          >
            <option value="norm">norm</option>
            {componentOptions.map((indices) => (
              <option key={indices.join(',')} value={`component:${indices.join(',')}`}>
                {componentLabel(indices, identityBasis)} [{indices.join(',')}]
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
        {Array.from({ length: rule.result.axes?.length ?? 0 }, (_, axisIndex) => {
          const axis = display.axes[axisIndex]
          return (
            <div className="rounded bg-slate-50 px-3 py-2" key={axisIndex}>
              <span className="font-semibold text-slate-700">{axis.name}</span>
              {' · '}
              {axis.unit && axis.unitOptions.length > 0 ? (
                <select
                  aria-label={`${rule.label} ${axis.name} axis display unit`}
                  className="max-w-40 rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs text-slate-800"
                  value={axis.unit}
                  onChange={(event) => onDisplayUnitChange?.(rule.label, axisIndex, event.target.value)}
                >
                  {axis.unitOptions.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              ) : (
                <span>{unitLabel(axis.unit)}</span>
              )}
              {' · '}
              <span>length {axis.length ?? 'dynamic'}</span>
              {' · '}
              <span className="font-mono">{axis.ticks ? JSON.stringify(axis.ticks) : 'dynamic ticks from result'}</span>
            </div>
          )
        })}
      </div>

      {error ? (
        <div className="mt-3 rounded bg-rose-50 p-3 text-xs text-rose-700" role="alert">
          {error}
        </div>
      ) : null}
      {display.conversionErrors.length > 0 ? (
        <div className="mt-3 rounded bg-rose-50 p-3 text-xs text-rose-700" role="alert">
          Display unit conversion failed. {display.conversionErrors.join(' ')}
        </div>
      ) : null}
      <div className="mt-4">
        {display.tensor ? (
          <TensorVisualization
            key={`${rule.result.dtype}-${JSON.stringify(display.tensor.axes.map((axis) => axis.length))}-${componentSelection}`}
            axisUnits={display.axisUnits}
            componentSelection={componentSelection}
            resultUnit={display.resultUnit}
            rule={rule}
            sourceUnit={rule.result.unit}
            tensor={display.tensor}
          />
        ) : (
          <EmptyPlot axisUnits={display.axisUnits} rule={rule} />
        )}
      </div>
    </article>
  )
}

function CatalogHydratedRecordedDataResults({
  displayUnits = {},
  onDisplayUnitChange,
  recordedData,
  rules,
}: Omit<RecordedDataResultsProps, 'quantityKinds'>) {
  const quantityKindNames = useMemo(
    () =>
      Object.freeze(
        [
          ...new Set(
            rules.flatMap((rule) => [
              ...(rule.result.quantityKind ? [rule.result.quantityKind] : []),
              ...(rule.result.axes ?? []).flatMap((axis) => (axis.quantityKind ? [axis.quantityKind] : [])),
            ]),
          ),
        ].sort(),
      ),
    [rules],
  )
  const catalogQuery = useQuery({
    enabled: quantityKindNames.length > 0,
    queryKey: ['catalog', 'recorded-data', quantityKindNames],
    queryFn: () =>
      catalogApi.runtimeSlice({
        solvers: [],
        quantityKinds: quantityKindNames,
        materialParameters: [],
        materialModels: [],
      }),
  })
  if (quantityKindNames.length > 0 && catalogQuery.isPending) {
    return (
      <section
        aria-label="Recorded Data Results"
        className="grid h-full min-h-48 place-items-center bg-slate-50 p-5 text-sm text-slate-500"
      >
        <p role="status">Recorded Data Catalog를 불러오는 중입니다.</p>
      </section>
    )
  }

  if (catalogQuery.isError) {
    return (
      <section
        aria-label="Recorded Data Results"
        className="grid h-full min-h-48 place-items-center bg-slate-50 p-5 text-sm text-rose-700"
      >
        <div className="text-center" role="alert">
          <p>Recorded Data Catalog를 불러오지 못했습니다.</p>
          <button className="mt-3 rounded border border-rose-300 px-3 py-1.5" onClick={() => catalogQuery.refetch()}>
            다시 시도
          </button>
        </div>
      </section>
    )
  }

  return (
    <RecordedDataResultsContent
      displayUnits={displayUnits}
      onDisplayUnitChange={onDisplayUnitChange}
      quantityKinds={
        new Map((catalogQuery.data?.quantityKinds ?? []).map((definition) => [definition.name, definition]))
      }
      recordedData={recordedData}
      rules={rules}
    />
  )
}

function RecordedDataResultsContent({
  displayUnits = {},
  onDisplayUnitChange,
  quantityKinds,
  recordedData,
  rules,
}: RecordedDataResultsProps & { quantityKinds: RecordedQuantityKinds }) {
  const resolved = useMemo(
    () => resolveCadViewerRecordedData(rules, recordedData, quantityKinds),
    [quantityKinds, recordedData, rules],
  )

  return (
    <section aria-label="Recorded Data Results" className="h-full overflow-auto bg-slate-50 p-4 sm:p-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900">Results</h2>
          <p className="mt-1 text-sm text-slate-500">
            Read-only tensor snapshots matched to Experiment recordedData labels.
          </p>
        </div>

        {resolved.error ? (
          <div className="mb-4 rounded bg-rose-50 p-3 text-sm text-rose-700" role="alert">
            {resolved.error}
          </div>
        ) : null}
        {resolved.unknownLabels.length > 0 ? (
          <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            Unknown recordedData labels: {resolved.unknownLabels.join(', ')}
          </div>
        ) : null}

        <div className="space-y-4">
          {resolved.entries.map((entry) => (
            <RecordedResultCard
              displayUnits={displayUnits[entry.rule.label]}
              entry={entry}
              key={entry.rule.label}
              onDisplayUnitChange={onDisplayUnitChange}
              quantityKinds={quantityKinds}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export function RecordedDataResults({ quantityKinds, ...props }: RecordedDataResultsProps) {
  return quantityKinds ? (
    <RecordedDataResultsContent {...props} quantityKinds={quantityKinds} />
  ) : (
    <CatalogHydratedRecordedDataResults {...props} />
  )
}

export default RecordedDataResults
