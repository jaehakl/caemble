import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkbenchShell } from './WorkbenchShell'

it('fills the remaining width without mounting the Viewer and keeps settings resizable', () => {
  const viewer = vi.fn(() => <span>Viewer</span>)
  const onLeftWidthRatioChange = vi.fn()
  const props = {
    menubar: null,
    ribbon: null,
    left: <span>Settings</span>,
    viewer: <Viewer />,
    right: <span>Analysis</span>,
    leftWidthRatio: 0.25,
    onLeftWidthRatioChange,
  }
  function Viewer() {
    return viewer()
  }
  const { rerender } = render(<WorkbenchShell {...props} showViewer={false} />)
  expect(viewer).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: '3D CAD View' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('separator')).toHaveLength(1)
  const content = screen.getByRole('region', { name: 'Detail' })
  expect(content).toHaveTextContent('Analysis')
  expect(content.parentElement).toHaveStyle({ gridTemplateColumns: '320px 8px minmax(0, 1fr)', minWidth: '0' })
  const handle = screen.getByRole('separator', { name: '왼쪽 목록 너비 조절' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(onLeftWidthRatioChange).toHaveBeenLastCalledWith(336 / 1280)
  fireEvent.keyDown(handle, { key: 'End' })
  expect(onLeftWidthRatioChange).toHaveBeenLastCalledWith(932 / 1280)

  rerender(<WorkbenchShell {...props} />)
  expect(screen.getByRole('region', { name: '3D CAD View' })).toHaveTextContent('Viewer')
  expect(screen.getAllByRole('separator')).toHaveLength(2)
})
