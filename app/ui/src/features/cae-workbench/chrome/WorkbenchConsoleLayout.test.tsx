import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import type { BottomDockMode } from '../types'
import { WorkbenchConsoleLayout } from './WorkbenchConsoleLayout'

it('uses the status-bar height when collapsed and resizes the global Console when expanded', () => {
  function Harness() {
    const [mode, setMode] = useState<BottomDockMode>('hidden')
    const [heightRatio, setHeightRatio] = useState(0.5)
    return (
      <WorkbenchConsoleLayout
        console={<div data-testid="console">Console</div>}
        heightRatio={heightRatio}
        mode={mode}
        onHeightRatioChange={setHeightRatio}
      >
        <button onClick={() => setMode('console')}>펼치기</button>
      </WorkbenchConsoleLayout>
    )
  }

  render(<Harness />)
  expect(screen.getByTestId('console').parentElement).toHaveStyle({ height: '28px' })

  fireEvent.click(screen.getByRole('button', { name: '펼치기' }))
  const resize = screen.getByRole('separator', { name: 'Console 높이 조절' })
  expect(resize).toHaveAttribute('aria-valuenow', '320')

  fireEvent.keyDown(resize, { key: 'ArrowUp' })
  expect(resize).toHaveAttribute('aria-valuenow', '332')
})
