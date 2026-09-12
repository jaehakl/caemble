import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { usePreflight } from '@/features/measurement/usePreflight'
import { useExperimentSaveWorkflow } from './useExperimentSaveWorkflow'

const mocks = vi.hoisted(() => ({ usage: vi.fn(), capture: vi.fn(), crop: vi.fn() }))
vi.mock('@/api', () => ({ dbTables: { Experiment: { usage: mocks.usage } } }))
vi.mock('@/features/viewer/persistence/viewerThumbnail', () => ({
  captureViewer: mocks.capture,
  cropThumbnail: mocks.crop,
  centeredThumbnailCrop: () => ({ x: 0, y: 0, width: 640, height: 480 }),
}))
vi.mock('./SaveExperimentDialog', () => ({ experimentSaveDefaults: () => ({ name: 'Current' }) }))

function setup(saved = true, count = 0) {
  const saveExperiment = vi.fn().mockResolvedValue({ id: 1, version: '0.1.0' })
  const clear = vi.fn()
  const setDialog = vi.fn()
  const sourceBundle = { files: { 'experiment.tsx': 'current source' } }
  const workbench = {
    experimentId: saved ? 1 : null,
    experimentRecord: saved ? { id: 1 } : null,
    experimentManageable: true,
    experiment: { sourceBundle },
    saveExperiment,
    refreshExperimentUsage: vi.fn().mockResolvedValue(undefined),
  } as unknown as CaeWorkbenchState
  const preflight = {
    result: { experiment: { sourceBundle }, payload: { id: 'preflight' } },
    clear,
  } as unknown as ReturnType<typeof usePreflight>
  mocks.usage.mockResolvedValue({ items: [{ derivedCounts: { measurements: count } }] })
  return {
    ...renderHook(() => useExperimentSaveWorkflow(workbench, preflight, { current: null }, setDialog)),
    saveExperiment,
    clear,
    setDialog,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capture.mockResolvedValue({ width: 640, height: 480, url: 'snapshot' })
  mocks.crop.mockResolvedValue('webp')
})
describe('Experiment Save workflow', () => {
  it('opens Save As for Draft without writing', async () => {
    const test = setup(false)
    await act(() => test.result.current.save())
    expect(test.setDialog).toHaveBeenCalledWith('save-experiment-as')
    expect(test.saveExperiment).not.toHaveBeenCalled()
    expect(mocks.usage).not.toHaveBeenCalled()
  })
  it('checks usage and asks for a version when any Measurement exists', async () => {
    const test = setup(true, 1)
    await act(() => test.result.current.save())
    expect(mocks.usage).toHaveBeenCalledWith([1])
    expect(test.setDialog).toHaveBeenCalledWith('save-experiment-version')
    expect(test.saveExperiment).not.toHaveBeenCalled()
  })
  it('overwrites unused experiments with central crop and the shared Preflight option', async () => {
    const test = setup()
    act(() => test.result.current.setIncludePreflight(false))
    await act(() => test.result.current.save())
    expect(test.saveExperiment).toHaveBeenCalledWith(
      { name: 'Current' },
      'overwrite',
      expect.objectContaining({ thumbnail: 'webp', preflightBatchId: undefined, requestId: expect.any(String) }),
    )
    expect(test.clear).toHaveBeenCalledOnce()
  })
  it('preserves Preflight and request ID after a lost response; suppresses duplicate clicks', async () => {
    const test = setup()
    test.saveExperiment.mockRejectedValueOnce(new Error('connection lost'))
    await act(async () => {
      await Promise.all([test.result.current.save(), test.result.current.save()])
    })
    expect(test.saveExperiment).toHaveBeenCalledOnce()
    expect(test.clear).not.toHaveBeenCalled()
    const args = test.saveExperiment.mock.calls[0]
    await act(() => test.result.current.save())
    expect(test.saveExperiment.mock.calls[1]).toEqual(args)
    expect(mocks.usage).toHaveBeenCalledOnce()
    expect(args[2].preflightBatchId).toBe('preflight')
    expect(test.clear).toHaveBeenCalledOnce()
  })
  it('still saves without a thumbnail when capture is unavailable', async () => {
    mocks.capture.mockRejectedValue(new Error('empty viewer'))
    const test = setup()
    await act(() => test.result.current.save())
    expect(test.saveExperiment.mock.calls[0][2].thumbnail).toBeUndefined()
    expect(test.result.current.captureError).toBe('empty viewer')
  })
})
