import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ExperimentWorkspace } from './ExperimentWorkspace'

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
