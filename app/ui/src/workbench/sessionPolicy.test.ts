import { describe, expect, it } from 'vitest'
import { readWorkbenchUrlExperiment, replacementDisposition, writeWorkbenchUrlExperiment } from './sessionPolicy'

describe('Workbench session policy', () => {
  it('reads only a positive integer Experiment ID from the URL', () => {
    expect(readWorkbenchUrlExperiment(new URLSearchParams('experiment=4&measurement=8&section=measurement'))).toBe(4)
    expect(readWorkbenchUrlExperiment(new URLSearchParams('experiment=-1'))).toBeNull()
    expect(readWorkbenchUrlExperiment(new URLSearchParams('experiment=1.5'))).toBeNull()
    expect(readWorkbenchUrlExperiment(new URLSearchParams('experiment=NaN'))).toBeNull()
  })

  it('preserves unrelated params and canonicalizes all retired Workbench params', () => {
    const next = writeWorkbenchUrlExperiment(
      new URLSearchParams(
        'keep=yes&experiment=3&measurement=8&calculation=9&section=measurement&structure=3&sample=2&setup=1',
      ),
      7,
    )

    expect(next.toString()).toBe('keep=yes&experiment=7')
    expect(writeWorkbenchUrlExperiment(next, null).toString()).toBe('keep=yes')
  })

  it('gives pending persistence and active work priority over dirty confirmation', () => {
    const base = {
      calculationDirty: true,
      calculationRunning: true,
      experimentDirty: true,
      measurementRunning: true,
      saving: true,
    }
    expect(replacementDisposition({ ...base, pendingRecord: true })).toBe('blocked-by-pending-record')
    expect(replacementDisposition({ ...base, pendingRecord: false })).toBe('blocked-by-save')
    expect(replacementDisposition({ ...base, pendingRecord: false, saving: false })).toBe('blocked-by-running-workflow')
  })

  it('asks about Calculation before Experiment and otherwise runs immediately', () => {
    expect(
      replacementDisposition({
        calculationDirty: true,
        calculationRunning: false,
        experimentDirty: true,
        measurementRunning: false,
        pendingRecord: false,
        saving: false,
      }),
    ).toBe('confirm-calculation-replacement')
    expect(
      replacementDisposition({
        calculationDirty: false,
        calculationRunning: false,
        experimentDirty: false,
        measurementRunning: false,
        pendingRecord: false,
        saving: false,
      }),
    ).toBe('run')
  })
})
