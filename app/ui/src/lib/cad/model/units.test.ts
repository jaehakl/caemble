import { describe, expect, it } from 'vitest'
import { CadModelError } from './errors'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit } from './units'

describe('UCUM units', () => {
  it('preserves valid case-sensitive UCUM codes and rejects malformed input', () => {
    ;['1', '%', 'mV', 'V', 'mm', 'A/m2', 'S/m'].forEach((unit) => {
      expect(normalizeUcumUnit(unit, 'unit')).toBe(unit)
    })

    ;['', ' mV', 'mV ', 'not-a-unit', 'mv'].forEach((unit) => {
      expect(() => normalizeUcumUnit(unit, 'unit')).toThrow(CadModelError)
    })
  })

  it('converts physical and dimensionless values without canonicalizing their declarations', () => {
    expect(convertUcumValue(1, 'mV', 'V')).toBeCloseTo(0.001)
    expect(convertUcumValue(1, 'mm', 'm')).toBeCloseTo(0.001)
    expect(convertUcumValue(35, '%', undefined)).toBeCloseTo(0.35)
    expect(convertUcumValue(0.25, undefined, '1')).toBeCloseTo(0.25)
    expect(() => assertUcumUnitComparable('s', 'm', 'length')).toThrow('cannot convert s to m')
  })
})
