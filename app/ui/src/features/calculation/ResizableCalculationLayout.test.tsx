import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ResizableCalculationLayout } from './ResizableCalculationLayout'

it('renders two columns and supports keyboard resizing', () => {
  const change = vi.fn()
  const props = {
    columnRatios: [4 / 7, 3 / 7],
    onColumnRatiosChange: change,
    editor: 'Editor',
    output: 'Output',
  }
  render(<ResizableCalculationLayout {...props} />)
  expect(screen.getAllByRole('separator')).toHaveLength(1)
  fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
  const ratios = change.mock.calls[0][0] as number[]
  expect(ratios).toHaveLength(2)
  expect(ratios[0]).toBeGreaterThan(4 / 7)
  expect(ratios[1]).toBeLessThan(3 / 7)
  expect(ratios[0] + ratios[1]).toBeCloseTo(1)
  expect(screen.queryByLabelText('3D Viewer')).not.toBeInTheDocument()
  expect(screen.getByText('Editor')).toBeInTheDocument()
})
