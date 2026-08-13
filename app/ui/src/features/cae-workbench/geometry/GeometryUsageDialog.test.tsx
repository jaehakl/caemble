// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeometryUsageDialog } from './GeometryUsageDialog'

afterEach(cleanup)

describe('GeometryUsageDialog', () => {
  it('copies an exact geometry.tsx import and opens geometry.tsx', async () => {
    const user = userEvent.setup()
    const snippet = 'import { Part as Child } from "caemble:geometry/jlee/common/part@1.0.0"'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const open = vi.fn()
    render(<GeometryUsageDialog snippet={snippet} onOpenChange={vi.fn()} onOpenGeometrySource={open} open />)
    expect(screen.getByText(snippet)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '코드 복사' }))
    expect(writeText).toHaveBeenCalledWith(snippet)
    await user.click(screen.getByRole('button', { name: 'geometry.tsx 열기' }))
    expect(open).toHaveBeenCalledOnce()
  })
})
