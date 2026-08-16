import { describe, expect, it } from 'vitest'
import type { MaterialNameRecord, MaterialRecord } from '@/api'
import { materialTestCatalog } from './material-test-fixtures'
import { getQualifierNames, isMaterialCatalogKey, materialDisplayName } from './material-utils'

describe('Material management helpers', () => {
  it('uses the alphabetically first visible name and falls back to the id', () => {
    const material = { id: 7, user_id: null } satisfies MaterialRecord
    const names = [
      { id: 1, material_id: 7, name: 'Zinc', user_id: null },
      { id: 2, material_id: 7, name: 'Copper', user_id: null },
      { id: 3, material_id: 8, name: 'Other', user_id: null },
    ] satisfies MaterialNameRecord[]
    expect(materialDisplayName(material, names)).toBe('Copper')
    expect(materialDisplayName({ id: 9, user_id: null }, names)).toBe('Material #9')
  })

  it('accepts only material catalog keys and excludes dedicated qualifiers', () => {
    expect(isMaterialCatalogKey('test.matrix_property', materialTestCatalog)).toBe(true)
    expect(isMaterialCatalogKey('arbitrary.value', materialTestCatalog)).toBe(false)
    const qualifiers = getQualifierNames('test.matrix_property', materialTestCatalog)
    expect(qualifiers).toContain('test_frame')
    expect(qualifiers).toContain('test_condition')
    expect(qualifiers).not.toContain('frequency')
    expect(qualifiers).not.toContain('source')
  })
})
