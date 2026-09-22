import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { createRuntimeConsoleStore } from '@/features/runtime-console/store'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { useExperimentWarnings } from './useExperimentWarnings'

it('reports unique warnings once per completed revision or run, including after clearing the console', () => {
  const store = createRuntimeConsoleStore()
  const document = {
    resultSessionKey: 'experiment-1',
    revision: 1,
    successfulRevision: 1,
    completedCandidateGeneration: 0,
    runIsBusy: false,
    materialWarnings: ['재료 경고', '재료 경고'],
    draftTaskNames: ['solve'],
  } as unknown as CadDocumentController
  const { rerender } = renderHook(({ doc }) => useExperimentWarnings(doc, store.append), {
    initialProps: { doc: document },
  })
  expect(store.getSnapshot().events).toHaveLength(2)
  expect(store.getSnapshot().events.every((event) => event.level === 'warning')).toBe(true)
  rerender({ doc: { ...document, materialWarnings: ['재료 경고'] } })
  expect(store.getSnapshot().events).toHaveLength(2)
  store.clear()
  rerender({ doc: { ...document } })
  expect(store.getSnapshot().events).toHaveLength(0)
  rerender({ doc: { ...document, revision: 2, runIsBusy: true } })
  rerender({ doc: { ...document, revision: 2 } })
  expect(store.getSnapshot().events).toHaveLength(0)
  rerender({ doc: { ...document, revision: 2, successfulRevision: 2 } })
  expect(store.getSnapshot().events).toHaveLength(2)
  rerender({ doc: { ...document, revision: 2, successfulRevision: 2, completedCandidateGeneration: 1 } })
  expect(store.getSnapshot().events).toHaveLength(4)
})
