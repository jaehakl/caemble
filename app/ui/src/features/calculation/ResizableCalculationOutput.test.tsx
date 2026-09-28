import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResizableCalculationOutput } from './ResizableCalculationOutput'

vi.mock('./CalculationOutputChart', () => ({ CalculationOutputChart: () => <div>Chart</div> }))
vi.mock('./CalculationLogPanel', () => ({ CalculationLogPanel: () => <div>Logs</div> }))

afterEach(() => vi.unstubAllGlobals())

it('keeps the current Calculation title visible across preview states and supplies a draft fallback', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    },
  )
  const props = { chartRatio: 0.65, logs: [], onChartRatioChange: vi.fn() }
  const view = render(
    <ResizableCalculationOutput
      {...props}
      calculationName="First"
      preview={{ status: 'loading', message: 'Loading' }}
    />,
  )
  expect(screen.getByRole('heading', { name: 'First' })).toHaveAttribute('title', 'First')
  view.rerender(
    <ResizableCalculationOutput
      {...props}
      calculationName="Renamed calculation"
      preview={{ status: 'error', code: 'runtime', message: 'Failed' }}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Renamed calculation' })).toHaveClass('truncate')
  expect(screen.queryByRole('heading', { name: 'First' })).not.toBeInTheDocument()
  view.rerender(
    <ResizableCalculationOutput {...props} calculationName="" preview={{ status: 'idle', message: 'Empty' }} />,
  )
  expect(screen.getByRole('heading', { name: '새 Calculation' })).toBeInTheDocument()
})
