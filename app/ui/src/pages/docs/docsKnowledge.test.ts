import { describe, expect, it } from 'vitest'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import {
  catalogDocsKnowledge,
  catalogSearchKnowledge,
  getDocsKnowledge,
  manualDocsKnowledge,
  searchDocsKnowledge,
} from './docsKnowledge'

describe('documentation knowledge registry', () => {
  it('keeps the Manual section contract, unique anchors and legacy deep links', () => {
    expect(new Set(manualDocsKnowledge.map(({ id }) => id)).size).toBe(manualDocsKnowledge.length)
    const anchors = manualDocsKnowledge.flatMap(({ aliases = [], anchor }) => (anchor ? [anchor, ...aliases] : aliases))
    expect(new Set(anchors).size).toBe(anchors.length)
    expect(anchors).toEqual(
      expect.arrayContaining([
        'experiment-physical-model',
        'experiment-vars-geometry',
        'experiment-materials',
        'experiment-verified-example',
        'cad-reference-v7-migration',
      ]),
    )
    expect(new Set(manualDocsKnowledge.map(({ section }) => section))).toEqual(
      new Set(['workbench', 'program', 'reference', 'troubleshooting']),
    )
    expect(manualDocsKnowledge.every(({ content, href }) => content && href.startsWith('/docs?section='))).toBe(true)
  })

  it('builds examples and Geometry reference from shared executable sources', () => {
    expect(manualDocsKnowledge.find(({ id }) => id === 'program-definition')?.content).toContain(
      'export default experiment({',
    )
    expect(manualDocsKnowledge.find(({ id }) => id === 'program-task')?.content).toContain("name: 'dc-current-density'")
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-skeleton')?.content).toContain(
      geometryAuthoringSkeletonCode.trim(),
    )
    expect(catalogDocsKnowledge.find(({ id }) => id === 'geometry:box')?.content).toContain('<Box size=')
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-transforms')?.content).toContain(
      '<rotate axis=',
    )
    expect(catalogDocsKnowledge.some(({ section }) => section === 'materials')).toBe(false)
  })

  it('ranks Manual and live catalog matches and produces stable catalog links', () => {
    const serverResults = catalogSearchKnowledge([
      {
        kind: 'materialParameter',
        key: 'electrical.conductivity',
        title: 'electrical.conductivity',
        subtitle: 'electromagnetism.ElectricConductivity',
      },
      { kind: 'solver', key: 'dc-current-density@0.1.0', title: 'DC current density', subtitle: 'Solver' },
    ])

    expect(searchDocsKnowledge('electrical.conductivity', [...getDocsKnowledge(), ...serverResults])[0]?.id).toBe(
      'materialParameter:electrical.conductivity',
    )
    expect(searchDocsKnowledge('invalid_unit').map(({ id }) => id)).toContain('troubleshooting-units-materials')
    expect(
      searchDocsKnowledge('Joule heating 이전 질문은 multiphysics')
        .slice(0, 3)
        .map(({ id }) => id),
    ).toContain('program-multiphysics-example')
    expect(serverResults[1].href).toBe('/docs?section=solvers&item=dc-current-density%400.1.0')
  })
})
