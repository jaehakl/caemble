import { describe, expect, it } from 'vitest'
import source from './manifests.ts?raw'

describe('CAE solver catalog adapter', () => {
  it('loads descriptors from the catalog API without bundling raw manifests', () => {
    expect(source).toContain('catalogApi.listSolvers')
    expect(source).toContain('catalogApi.getSolver')
    expect(source).not.toContain('import.meta.glob')
    expect(source).not.toContain('manifest.json')
  })
})
