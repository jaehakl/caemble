import { describe, expect, it } from 'vitest'
import { appRoutePaths } from '@/app/router'
import { defaultExperimentCode } from '@/lib/defaultExperimentCode'
import { defaultExperimentTaskCode } from '@/lib/defaultExperimentProgramCode'
import { defaultExperimentSimulationCode } from '@/lib/defaultExperimentSimulationCode'
import { catalogCounts } from '@/lib/metadata'

describe('CAE Workbench와 문서 라우팅', () => {
  it('루트 Workbench, 통합 문서와 Not Found를 등록한다', () => {
    expect(appRoutePaths).toEqual(['index', 'docs', '*'])
  })

  it('기존 제품 및 Viewer URL을 공개 route로 등록하지 않는다', () => {
    expect(appRoutePaths).not.toEqual(
      expect.arrayContaining([
        'cae',
        'analysis',
        'ai/chat',
        'launchers',
        'jobs',
        'materials',
        'catalog/cad/:tag?',
        'login',
        'account',
        'viewer',
        'structures',
        'experiments',
        'examples/:exampleId?',
        'measurements',
      ]),
    )
  })

  it('카탈로그 수와 독립 Experiment 예제를 유지한다', () => {
    expect(catalogCounts).toEqual({ cad: 11, materials: 260, quantityKinds: 1_216, solvers: 1 })
    expect(defaultExperimentCode).toContain("import { experiment } from '@caemble/core'")
    expect(defaultExperimentTaskCode).toContain("import { defineTask } from '@caemble/core'")
    expect(defaultExperimentTaskCode).toContain("kernel: { name: 'dc-current-density'")
    expect(defaultExperimentTaskCode).toContain("methodId: 'dc.voxel-grid'")
    expect(defaultExperimentCode).toContain("quantityKind: 'electromagnetism.ElectricCurrent'")
    expect(defaultExperimentCode).not.toContain('simulate:')
    expect(defaultExperimentSimulationCode).toContain('await sim.record(')
    expect(defaultExperimentSimulationCode).toContain('"measuredCurrent"')
  })
})
