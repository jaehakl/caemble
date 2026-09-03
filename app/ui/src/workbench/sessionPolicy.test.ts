import { describe, expect, it } from 'vitest'
import { readWorkbenchUrlSelection, replacementDisposition, writeWorkbenchUrlSelection } from './sessionPolicy'

describe('Workbench session policy', () => {
  it('accepts only positive integer IDs and known sections from the URL', () => {
    expect(
      readWorkbenchUrlSelection(new URLSearchParams('experiment=4&measurement=-1&calculation=1.5&section=measurement')),
    ).toEqual({ experimentId: 4, measurementId: null, calculationId: null, section: 'measurement' })
    expect(readWorkbenchUrlSelection(new URLSearchParams('experiment=NaN&section=unknown')).section).toBeNull()
  })

  it('preserves unrelated params while replacing selection and removing legacy selection params', () => {
    const next = writeWorkbenchUrlSelection(new URLSearchParams('keep=yes&structure=3&sample=2&setup=1'), {
      experimentId: 7,
      measurementId: null,
      calculationId: 9,
      section: 'measurement',
    })

    expect(next.toString()).toBe('keep=yes&experiment=7&calculation=9&section=measurement')
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
