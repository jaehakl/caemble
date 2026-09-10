import { describe, expect, it } from 'vitest'
import { restoreDomainRecordAxes } from './domainRecordAxes'
import type { DataTensor } from '../model/descriptor'

const tensor: DataTensor = { shape: [4, 3], storage: { kind: 'inline', value: [] } }

describe('legacy domain axes', () => {
  it('restores coordinate axes without copying or changing stored values', () => {
    const result = restoreDomainRecordAxes(tensor, { axes: [{ name: 'node' }, { length: 3 }] }, 0, true)
    expect(result.axes).toEqual([{ implicitOrdinal: true }, { implicitOrdinal: true }])
    expect(result.storage).toBe(tensor.storage)
    expect(tensor.axes).toBeUndefined()
  })
  it('keeps vector components out of the external axes', () => {
    expect(restoreDomainRecordAxes(tensor, { axes: [{ name: 'node' }] }, 1, true).axes).toHaveLength(1)
  })
  it('does not fabricate physical coordinates or repair malformed layouts', () => {
    for (const axes of [
      [{ name: 'time' }, { length: 3 }],
      [{ name: 'node', unit: 's' }, { length: 3 }],
      [{ name: 'node' }],
      [{ name: 'node' }, { length: 4 }],
    ]) {
      expect(restoreDomainRecordAxes(tensor, { axes }, 0, true)).toBe(tensor)
    }
    expect(restoreDomainRecordAxes(tensor, { axes: [{ name: 'node' }, { length: 3 }] }, 0, false)).toBe(tensor)
    const stored = { ...tensor, axes: [{ ticks: [1, 2, 3, 4] }] }
    expect(restoreDomainRecordAxes(stored, { axes: [{ name: 'node' }] }, 1, true)).toBe(stored)
  })
})
