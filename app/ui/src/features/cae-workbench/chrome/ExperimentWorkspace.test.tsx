import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExperimentWorkspace } from './ExperimentWorkspace'

afterEach(() => vi.unstubAllGlobals())

it('resizes and collapses Vars without remounting Viewer or Editor, including narrow containers', () => {
  let resized: () => void = () => undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  let mounts = 0
  function Pane() {
    const [instance] = useState(() => ++mounts)
    return <span>{instance}</span>
  }
  render(
    <ExperimentWorkspace
      menubar={null}
      ribbon={null}
      vars={<span>Vars content</span>}
      viewer={<Pane />}
      editor={<Pane />}
    />,
  )
  const separator = screen.getByRole('separator', { name: 'Vars 너비 조절' })
  expect(separator).toHaveAttribute('aria-valuenow', '280')
  fireEvent.keyDown(separator, { key: 'End' })
  expect(separator).toHaveAttribute('aria-valuenow', '480')
  fireEvent.click(screen.getByRole('button', { name: 'Vars 접기' }))
  expect(screen.getByText('Vars content')).not.toBeVisible()
  expect(screen.getByRole('region', { name: '3D Viewer' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Vars 펼치기' }))
  expect(screen.getByText('Vars content')).toBeVisible()
  expect(separator).toHaveAttribute('aria-valuenow', '480')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect)
  act(() => resized())
  expect(separator).toHaveAttribute('aria-valuemax', '160')
  expect(separator).toHaveAttribute('aria-valuenow', '160')
  expect(mounts).toBe(2)
})

it('starts at 50:50, resizes by keyboard, and preserves the Viewer instance while resizing', () => {
  let mounts = 0
  function Viewer() {
    const [value] = useState(() => ++mounts)
    return <output aria-label="Viewer instance">{value}</output>
  }
  function Harness() {
    return (
      <ExperimentWorkspace menubar={null} ribbon={null} viewer={<Viewer />} editor={<textarea aria-label="Code" />} />
    )
  }
  render(<Harness />)
  const split = screen.getByRole('separator', { name: 'Viewer와 Editor 크기 조절' })
  expect(split).toHaveAttribute('aria-valuenow', '50')
  fireEvent.keyDown(split, { key: 'ArrowRight' })
  expect(split).toHaveAttribute('aria-valuenow', '52')
  expect(screen.getByLabelText('Viewer instance')).toHaveTextContent('1')
  expect(screen.getByLabelText('Code')).toBeVisible()
  expect(screen.getByRole('separator', { name: 'Viewer와 Editor 크기 조절' })).toHaveAttribute('aria-valuenow', '52')
  expect(mounts).toBe(1)
})
