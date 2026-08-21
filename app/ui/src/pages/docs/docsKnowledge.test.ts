import { describe, expect, it } from 'vitest'
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

  it('links manual examples to canonical catalog detail instead of duplicating full source', () => {
    expect(manualDocsKnowledge.find(({ id }) => id === 'program-definition')?.content).toContain(
      'item=experiment:dc-uniform-bar',
    )
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-skeleton')?.content).toContain(
      'item=example:geometry-authoring-skeleton',
    )
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-skeleton')?.content).not.toContain(
      'export const Assembly',
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
      { kind: 'geometry', key: 'basketball-goal', title: 'Basketball Goal', subtitle: 'Example Geometry' },
      { kind: 'experiment', key: 'dc-uniform-bar', title: 'DC Uniform Bar', subtitle: 'Official Experiment' },
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
    expect(serverResults[2].item).toBe('example:basketball-goal')
    expect(serverResults[3].item).toBe('experiment:dc-uniform-bar')
  })
})
