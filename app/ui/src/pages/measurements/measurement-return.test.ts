import { describe, expect, it } from 'vitest'
import { readMeasurementReturnTo, updateMeasurementReturnTo } from './measurement-return'

describe('Measurement manager return links', () => {
  it('accepts only canonical and Viewer-alias Measurement workspace state', () => {
    expect(readMeasurementReturnTo({ measurementReturnTo: '/measurements?structure=1' })).toBe(
      '/measurements?structure=1',
    )
    expect(readMeasurementReturnTo({ measurementReturnTo: '/viewer?structure=1' })).toBe('/viewer?structure=1')
    expect(readMeasurementReturnTo({ measurementReturnTo: '/materials' })).toBeNull()
    expect(readMeasurementReturnTo(null)).toBeNull()
  })

  it('keeps compatible children and clears only dependencies of a changed parent', () => {
    const current = '/measurements?structure=1&sample=10&experiment=2&setup=20&measurement=30'
    expect(updateMeasurementReturnTo(current, 'structure', 1)).toBe(current)
    expect(updateMeasurementReturnTo(current, 'structure', 3)).toBe('/measurements?structure=3&experiment=2&setup=20')
    expect(updateMeasurementReturnTo(current, 'experiment', 4)).toBe('/measurements?structure=1&sample=10&experiment=4')
    expect(updateMeasurementReturnTo(current.replace('/measurements', '/viewer'), 'structure', 3)).toBe(
      '/viewer?structure=3&experiment=2&setup=20',
    )
  })
})
