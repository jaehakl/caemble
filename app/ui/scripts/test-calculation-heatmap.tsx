import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { CalculationOutputChart } from '../src/features/cae-workbench/calculation/CalculationOutputChart'
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

console.info('Calculation heatmap tests passed.')
