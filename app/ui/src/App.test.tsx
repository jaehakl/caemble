import { describe, expect, it, vi } from 'vitest'
import { redirectLegacyHash } from '@/app/legacy-routes'
import { appRoutePaths, redirectViewerToStructures } from '@/app/router'
import { defaultExperimentCode } from '@/lib/defaultExperimentCode'
import { defaultExperimentSimulationCode } from '@/lib/defaultExperimentSimulationCode'
import { catalogCounts } from '@/lib/metadata'

describe('페이지 중심 앱 라우팅', () => {
  it('직접 진입할 모든 공개·계정 URL을 등록한다', () => {
    expect(appRoutePaths).toEqual([
      'index',
      'viewer',
      'structures',
      'experiments',
      'examples/:exampleId?',
      'measurements',
      'analysis',
      'materials',
      'materials/:materialId',
      'catalog/cad/:tag?',
      'catalog/materials/:key?',
      'catalog/quantity-kinds/:name?',
      'catalog/solvers/:name?/:version?',
      'docs',
      'login',
      'account',
      '*',
    ])
  })

  it.each([
    ['#viewer', '/structures?from=legacy&structure=new&mode=code'],
    ['#help', '/docs'],
  ])('legacy hash %s를 %s로 이동한다', (hash, target) => {
    const replaceState = vi.fn()
    redirectLegacyHash(
      { hash, pathname: '/', search: '?from=legacy' } as Location,
      { replaceState } as unknown as History,
    )
    expect(replaceState).toHaveBeenCalledWith(null, '', hash === '#viewer' ? target : `${target}?from=legacy`)
  })

  it.each([
    ['https://caemble.test/viewer', '/structures?structure=new&mode=code'],
    ['https://caemble.test/viewer?structure=111&experiment=112&sample=113', '/structures?structure=new&mode=code'],
    ['https://caemble.test/viewer?from=bookmark&measurement=114', '/structures?from=bookmark&structure=new&mode=code'],
  ])('retired Viewer URL %s를 새 Structure 코드 모드로 이동한다', (url, target) => {
    const response = redirectViewerToStructures(new Request(url))
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(target)
  })

  it('카탈로그 수와 독립 Experiment 예제를 유지한다', () => {
    expect(catalogCounts).toEqual({ cad: 11, materials: 260, quantityKinds: 1_216, solvers: 1 })
    expect(defaultExperimentCode).toContain("import { defineTask, experiment } from '@caemble/core'")
    expect(defaultExperimentCode).toContain("electric: defineTask({ name: 'dc-current-density'")
    expect(defaultExperimentCode).toContain("methodId: 'dc.voxel-grid'")
    expect(defaultExperimentCode).toContain("quantityKind: 'electromagnetism.ElectricCurrent'")
    expect(defaultExperimentCode).not.toContain('simulate:')
    expect(defaultExperimentSimulationCode).toContain('await sim.record(')
    expect(defaultExperimentSimulationCode).toContain('"measuredCurrent"')
  })
})
