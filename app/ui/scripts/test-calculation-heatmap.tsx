import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { CalculationOutputChart } from '../src/features/calculation/CalculationOutputChart'
import { buildScalarHistogram } from '../src/features/calculation/calculationHistogram'
import { Heatmap } from '../src/features/viewer/viewer/Heatmap'

function renderHeatmap(
  rowTicks: readonly (number | string)[],
  columnTicks: readonly (number | string)[],
  calculation = true,
) {
  return renderToStaticMarkup(
    <Heatmap
      columnTicks={columnTicks}
      fillContainer={calculation}
      getValue={(rowIndex, columnIndex) => rowIndex * columnTicks.length + columnIndex}
      preserveTensorAspect={calculation}
      resultUnit={undefined}
      rowTicks={rowTicks}
      tickSignificantDigits={calculation ? 5 : undefined}
      xTitle="column"
      yTitle="row"
    />,
  )
}

function firstCellSize(markup: string) {
  const cell = markup.match(/<rect[^>]*>/)?.[0]
  assert.ok(cell)
  const width = cell.match(/width="([^"]+)"/)?.[1]
  const height = cell.match(/height="([^"]+)"/)?.[1]
  assert.ok(width)
  assert.ok(height)
  return { height: Number(height), width: Number(width) }
}

for (const [rows, columns, viewBox] of [
  [16, 16, '0 0 352 320'],
  [2, 4, '0 0 588 320'],
  [4, 2, '0 0 234 320'],
] as const) {
  const markup = renderHeatmap(
    Array.from({ length: rows }, (_, index) => index),
    Array.from({ length: columns }, (_, index) => index),
  )
  const cell = firstCellSize(markup)
  assert.equal(cell.width, cell.height, `${rows}x${columns} Calculation cells must be square`)
  assert.ok(markup.includes(`viewBox="${viewBox}"`))
  assert.ok(markup.includes('h-full min-h-0'))
}

const calculationMarkup = renderHeatmap([-0.014062499999999999, 1.234567, 123456, 1.234567e-7, 0], [0, 'station-A'])
for (const label of ['-0.014062', '1.2346', '123460', '1.2346e-7', '>0<', 'station-A']) {
  assert.ok(calculationMarkup.includes(label), `Expected formatted tick label ${label}`)
}
assert.ok(calculationMarkup.includes('-0.014062499999999999, 0: 0 unitless'))

const denseCalculationMarkup = renderHeatmap(
  [0, 1],
  Array.from({ length: 16 }, (_, index) => index),
)
assert.equal((denseCalculationMarkup.match(/text-anchor="middle"/g) ?? []).length, 6)

const recordedDataMarkup = renderHeatmap([1.234567, 2], [0, 1, 2, 3], false)
const recordedDataCell = firstCellSize(recordedDataMarkup)
assert.notEqual(recordedDataCell.width, recordedDataCell.height)
assert.ok(recordedDataMarkup.includes('>1.234567<'))
assert.ok(recordedDataMarkup.includes('viewBox="0 0 800 320"'))
assert.ok(recordedDataMarkup.includes('h-80'))

const policyErrorMarkup = renderToStaticMarkup(
  <CalculationOutputChart
    preview={{
      status: 'error',
      code: 'policy',
      message: 'Random functions are not supported in Calculation v1.',
      diagnostic: {
        message: 'Random functions are not supported in Calculation v1.',
        range: { startLineNumber: 2, startColumn: 15, endLineNumber: 2, endColumn: 21 },
        sourceLine: '  return Math.random()',
      },
    }}
  />,
)
for (const detail of [
  '허용되지 않은 Source',
  'Line 2, Column 15',
  'Random functions are not supported in Calculation v1.',
  'return Math.random()',
  '^^^^^^',
]) {
  assert.ok(policyErrorMarkup.includes(detail), `Expected policy detail ${detail}`)
}

const runtimeErrorMarkup = renderToStaticMarkup(
  <CalculationOutputChart preview={{ status: 'error', code: 'runtime', message: 'sensitive runtime detail' }} />,
)
assert.ok(runtimeErrorMarkup.includes('상세 오류는 중앙 하단 Console에서 확인하세요.'))
assert.equal(runtimeErrorMarkup.includes('sensitive runtime detail'), false)

const outlierHistogram = buildScalarHistogram([0, 1, 2, 3], 10)
assert.ok(outlierHistogram)
assert.equal(outlierHistogram.bins.length, 2)
assert.equal(outlierHistogram.markerRatio, 1)
assert.equal(outlierHistogram.domainMin, 0)
assert.equal(outlierHistogram.domainMax, 10)
const constantHistogram = buildScalarHistogram([5, 5, 5], 5)
assert.ok(constantHistogram)
assert.equal(constantHistogram.bins.length, 1)
assert.equal(constantHistogram.bins[0].count, 3)
assert.ok(constantHistogram.domainMin < 5 && constantHistogram.domainMax > 5)
assert.equal(buildScalarHistogram([], 1), null)

const scalarHistogramMarkup = renderToStaticMarkup(
  <CalculationOutputChart
    measurementId={42}
    preview={{ status: 'success', output: { dtype: 'float64', shape: [], data: 10, axes: [] } }}
    scalarValues={[0, 1, 2, 3]}
  />,
)
assert.ok(scalarHistogramMarkup.includes('data-result-visualization="histogram"'))
assert.ok(scalarHistogramMarkup.includes('Measurement #42'))
assert.ok(scalarHistogramMarkup.includes('Calculation scalar output histogram'))

const scalarWithoutPopulation = renderToStaticMarkup(
  <CalculationOutputChart
    comparisonMessage="수정한 Calculation을 저장하세요."
    preview={{ status: 'success', output: { dtype: 'float64', shape: [], data: 3, axes: [] } }}
    scalarValues={[]}
  />,
)
assert.ok(scalarWithoutPopulation.includes('data-result-visualization="scalar"'))
assert.ok(scalarWithoutPopulation.includes('수정한 Calculation을 저장하세요.'))

console.info('Calculation chart tests passed.')
