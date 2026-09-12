import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import type { BottomDockMode } from '../types'
import { WorkbenchBottomDock } from './WorkbenchBottomDock'

it('starts collapsed and toggles the Console with an accessible control', () => {
  function Harness() {
    const [mode, setMode] = useState<BottomDockMode>('hidden')
    return (
      <WorkbenchBottomDock
        console={<div>전체 Console</div>}
        mode={mode}
        onModeChange={setMode}
        summary={<span>최신 메시지</span>}
      />
    )
  }

  render(<Harness />)

  const toggle = screen.getByRole('button', { name: /Console/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('최신 메시지')).toBeVisible()
  expect(screen.getByText('전체 Console')).not.toBeVisible()

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('전체 Console')).toBeVisible()

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
