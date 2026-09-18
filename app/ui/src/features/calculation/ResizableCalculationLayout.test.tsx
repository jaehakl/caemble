import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ResizableCalculationLayout } from './ResizableCalculationLayout'

it('renders three columns and supports keyboard resizing', () => {
  const change = vi.fn()
  const props = {
    columnRatios: [0.3, 0.4, 0.3],
    onColumnRatiosChange: change,
    viewer: 'Viewer',
    editor: 'Editor',
    output: 'Output',
  }
  render(<ResizableCalculationLayout {...props} />)
  expect(screen.getAllByRole('separator')).toHaveLength(2)
  fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
  const ratios = change.mock.calls[0][0] as number[]
  expect(ratios).toHaveLength(3)
  expect(ratios[0]).toBeGreaterThan(0.3)
  expect(ratios[1]).toBeLessThan(0.4)
  expect(ratios[2]).toBeCloseTo(0.3)
  expect(screen.getByText('Viewer')).toBeInTheDocument()
  expect(screen.getByText('Editor')).toBeInTheDocument()
})
