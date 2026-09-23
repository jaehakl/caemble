import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { durableViewerSettings } from '@/contracts/viewerDefaults'
import { createViewerSelection, useViewerSelectionStore } from './viewerSelection'
import { createComparisonSettings, useViewerSelection, ViewerPersistenceContext } from './comparisonSettings'
import { createComparisonCamera } from './comparisonCamera'
import type { CadViewerSelectionQuery } from './model'

const geometry: CadViewerSelectionQuery = {
  kind: 'geometry',
  match: 'exact',
  origin: 'viewer',
  scope: { source: 'experiment' },
  value: 'body',
}

it('uses the latest input and does not let editor cursor exit clear a Viewer selection', () => {
  const selection = createViewerSelection()
  selection.selectFromCode(geometry)
  expect(selection.getSnapshot()?.origin).toBe('code')
  selection.select({ ...geometry, kind: 'surface', value: 'body/surface/1' })
  selection.selectFromCode(null)
  expect(selection.getSnapshot()?.value).toBe('body/surface/1')
  selection.selectFromCode({ ...geometry, value: 'other' })
  expect(selection.getSnapshot()?.value).toBe('other')
  selection.selectFromCode(null)
  expect(selection.getSnapshot()).toBeNull()
  selection.selectFromCode(geometry)
  selection.select(null)
  expect(selection.getSnapshot()).toBeNull()
})

it('notifies subscribers only when the effective query changes', () => {
  const selection = createViewerSelection()
  const listener = vi.fn()
  const unsubscribe = selection.subscribe(listener)
  selection.select(geometry)
  selection.select({ ...geometry, scope: { ...geometry.scope } })
  expect(listener).toHaveBeenCalledTimes(1)
  selection.select({ ...geometry, scope: { source: 'task', taskName: 'a' } })
  selection.select({ ...geometry, scope: { source: 'task', taskName: 'b' } })
  expect(listener).toHaveBeenCalledTimes(3)
  unsubscribe()
  selection.select(null)
  expect(listener).toHaveBeenCalledTimes(3)
})

it('keeps screen scopes independent and resets only for a new workspace session', () => {
  const { result, rerender } = renderHook(
    ({ session }) => [useViewerSelectionStore(session), useViewerSelectionStore(session)],
    {
      initialProps: { session: 1 },
    },
  )
  const original = result.current[0]
  original.select(geometry)
  rerender({ session: 1 })
  expect(result.current[0]).toBe(original)
  expect(result.current[0].getSnapshot()).toEqual(geometry)
  expect(result.current[1].getSnapshot()).toBeNull()
  rerender({ session: 2 })
  expect(result.current[0]).not.toBe(original)
  expect(result.current[0].getSnapshot()).toBeNull()
})

it('subscribes to the Viewer store across renderer remounts without serializing selection', () => {
  const settings = createComparisonSettings()
  const camera = createComparisonCamera()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ViewerPersistenceContext.Provider value={{ settings, camera, item: '' }}>
      {children}
    </ViewerPersistenceContext.Provider>
  )
  const first = renderHook(useViewerSelection, { wrapper })
  act(() => settings.selection.select(geometry))
  expect(first.result.current[0]).toEqual(geometry)
  first.unmount()
  const second = renderHook(useViewerSelection, { wrapper })
  expect(second.result.current[0]).toEqual(geometry)
  const saved = durableViewerSettings(settings.values.entries())
  expect(JSON.stringify(saved)).not.toContain('body')
  expect(createComparisonSettings(saved).selection.getSnapshot()).toBeNull()
})
