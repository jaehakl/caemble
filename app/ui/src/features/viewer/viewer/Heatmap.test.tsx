import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Heatmap } from './Heatmap'

it.each([
  [16, 16],
  [2, 4],
  [4, 2],
])('keeps %sx%s tensor cells square', (rows, columns) => {
  const { container } = render(
    <Heatmap
      columnTicks={Array.from({ length: columns }, (_, i) => i)}
      rowTicks={Array.from({ length: rows }, (_, i) => i)}
      fillContainer
      preserveTensorAspect
      getValue={(row, column) => row * columns + column}
      resultUnit={undefined}
      xTitle="column"
      yTitle="row"
    />,
  )
  const cells = container.querySelectorAll('rect')
  expect(cells).toHaveLength(rows * columns)
  for (const cell of cells) {
    expect(Number(cell.getAttribute('width'))).toBeCloseTo(Number(cell.getAttribute('height')))
  }
})

it('formats display ticks while retaining the original coordinates in tooltips', () => {
  const { container, rerender } = render(
    <Heatmap
      columnTicks={[0, 'station-A']}
      rowTicks={[-0.014062499999999999, 1.234567, 123456, 1.234567e-7, 0]}
      tickSignificantDigits={5}
      getValue={() => 7}
      resultUnit={undefined}
      xTitle="column"
      yTitle="row"
    />,
  )
  for (const label of ['-0.014062', '1.2346', '123460', '1.2346e-7', 'station-A']) {
    expect(screen.getByText(label)).toBeInTheDocument()
  }
  expect(container.querySelector('title')?.textContent).toContain('-0.014062499999999999, 0: 7')
  rerender(
    <Heatmap
      columnTicks={[0, 1, 2, 3]}
      rowTicks={[1.234567, 2]}
      getValue={() => 7}
      resultUnit={undefined}
      xTitle="column"
      yTitle="row"
    />,
  )
  expect(screen.getByText('1.234567')).toBeInTheDocument()
})

it('thins dense column labels and keeps both endpoint coordinates visible', () => {
  const { container } = render(
    <Heatmap
      columnTicks={Array.from({ length: 16 }, (_, i) => `station-${i}`)}
      rowTicks={[0, 1]}
      fillContainer
      getValue={() => 0}
      resultUnit={undefined}
      xTitle="column"
      yTitle="row"
    />,
  )
  expect(screen.getByText('station-0')).toBeInTheDocument()
  expect(screen.getByText('station-15')).toBeInTheDocument()
  expect(
    [...container.querySelectorAll('text')].filter((label) => label.textContent?.startsWith('station-')).length,
  ).toBeLessThan(16)
})
