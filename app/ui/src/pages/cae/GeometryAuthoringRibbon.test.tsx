// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { operationAuthoringElements, primitiveAuthoringElements } from '@/lib/cad'
import { GeometryAuthoringRibbon } from './GeometryAuthoringRibbon'

afterEach(cleanup)

describe('GeometryAuthoringRibbon', () => {
  it('shows the catalog primitive menu and dispatches the selected element', async () => {
    const user = userEvent.setup()
    const insertPrimitive = vi.fn(() => true)
    const state: CadEditorAuthoringState = {
      handle: { insertPrimitive, wrapSelection: vi.fn(() => true) },
      hasSelection: false,
    }
    render(<GeometryAuthoringRibbon state={state} />)

    expect(screen.getByRole('button', { name: 'Primitive' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Operation: 감쌀 코드 영역/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Primitive' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(primitiveAuthoringElements.length)
    await user.click(screen.getByRole('menuitem', { name: /^Box\b/u }))
    expect(insertPrimitive).toHaveBeenCalledWith(primitiveAuthoringElements.find((element) => element.tag === 'box'))
  })

  it('enables operations only for a non-empty editor selection', async () => {
    const user = userEvent.setup()
    const wrapSelection = vi.fn(() => true)
    const state: CadEditorAuthoringState = {
      handle: { insertPrimitive: vi.fn(() => true), wrapSelection },
      hasSelection: true,
    }
    const { rerender } = render(<GeometryAuthoringRibbon state={state} />)

    await user.click(screen.getByRole('button', { name: 'Operation' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(operationAuthoringElements.length)
    await user.click(screen.getByRole('menuitem', { name: /^union\b/u }))
    expect(wrapSelection).toHaveBeenCalledWith(operationAuthoringElements.find((element) => element.tag === 'union'))

    rerender(<GeometryAuthoringRibbon state={null} />)
    expect(screen.getByRole('button', { name: /Primitive: 현재 Editor/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Operation: 현재 Editor/ })).toBeDisabled()
  })
})
