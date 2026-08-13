// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeometryUsageDialog } from './GeometryUsageDialog'
import { geometryUsageCode } from './geometryUsage'

afterEach(cleanup)

describe('GeometryUsageDialog', () => {
  it('shows a copyable direct root JSX example and opens experiment.tsx', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const onOpenExperimentSource = vi.fn()
    render(
      <GeometryUsageDialog
        alias="NotchedConductor"
        onOpenChange={vi.fn()}
        onOpenExperimentSource={onOpenExperimentSource}
        open
      />,
    )

    expect(screen.getByText(/<NotchedConductor/)).toBeInTheDocument()
    expect(screen.getByText(/기본값 없는 필수 props는 Monaco 자동완성/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'JSX 복사' }))
    expect(writeText).toHaveBeenCalledWith(geometryUsageCode('NotchedConductor'))
    await user.click(screen.getByRole('button', { name: 'experiment.tsx 열기' }))
    expect(onOpenExperimentSource).toHaveBeenCalledOnce()
  })
})
