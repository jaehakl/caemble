import { describe, expect, it } from 'vitest'
import { defaultWorkbenchLayoutState } from '@/features/cae-workbench/types'
import { createWorkbenchShellStore } from './workbenchShellStore'

describe('createWorkbenchShellStore', () => {
  it('keeps Workbench instances isolated', () => {
    const first = createWorkbenchShellStore()
    const second = createWorkbenchShellStore()

    first.getState().setDialog('templates')
    first.getState().setLayout((layout) => ({ ...layout, activeSection: 'analysis' }))

    expect(first.getState().dialog).toBe('templates')
    expect(first.getState().layout.activeSection).toBe('analysis')
    expect(second.getState().dialog).toBeNull()
    expect(second.getState().layout).toEqual(defaultWorkbenchLayoutState)
  })
})
