import { describe, expect, it } from 'vitest'
import source from './manifests.ts?raw'

describe('bundled CAE solver manifests', () => {
  it('loads manifests directly from app/slaves at build time', () => {
    expect(source).toContain("import.meta.glob('../../../../slaves/cae/app/solvers/*/manifest.json'")
    expect(source).toContain('eager: true')
    expect(source).not.toContain('GpStationClient')
    expect(source).not.toContain('cae.solvers.manifests')
  })
})
