import { describe, expect, it } from 'vitest'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import {
  catalogSearchKnowledge,
  catalogDocsKnowledge,
  getDocsKnowledge,
  manualDocsKnowledge,
  searchDocsKnowledge,
} from './docsKnowledge'

describe('documentation knowledge registry', () => {
  it('uses unique chunks for every Manual section and produces deep links', () => {
    expect(new Set(manualDocsKnowledge.map(({ id }) => id)).size).toBe(manualDocsKnowledge.length)
    expect(new Set(manualDocsKnowledge.map(({ anchor }) => anchor)).size).toBe(manualDocsKnowledge.length)
    const allAnchors = manualDocsKnowledge.flatMap(({ aliases = [], anchor }) =>
      anchor ? [anchor, ...aliases] : aliases,
    )
    expect(new Set(allAnchors).size).toBe(allAnchors.length)
    expect(allAnchors).toEqual(
      expect.arrayContaining([
        'experiment-program-minimal-pair',
        'cad-reference-primitives',
        'cad-reference-task-recorded-data',
      ]),
    )
    expect(new Set(manualDocsKnowledge.map(({ section }) => section))).toEqual(
      new Set(['workbench', 'program', 'reference', 'troubleshooting']),
    )
    const everyChunkHasContentAndLink = manualDocsKnowledge.every(
      ({ content, href }) => content.length > 0 && href.startsWith('/docs?section='),
    )
    expect(everyChunkHasContentAndLink).toBe(true)
  })

  it('reuses the verified program sources instead of a documentation copy', () => {
    const experimentDefinition = manualDocsKnowledge.find(({ id }) => id === 'program-definition')
    const taskDefinition = manualDocsKnowledge.find(({ id }) => id === 'program-task')

    expect(experimentDefinition?.content).toContain('export default experiment({')
    expect(taskDefinition?.content).toContain("name: 'dc-current-density'")
    expect(manualDocsKnowledge.find(({ id }) => id === 'program-verified-examples')?.content).toContain(
      'Electro-Thermal Uniform Bar',
    )
    const basketballGoal = manualDocsKnowledge.find(({ id }) => id === 'reference-basketball-goal')?.content
    expect(basketballGoal).toContain('position={[0, 100, 298]}')
    expect(basketballGoal).toContain('rotation={[Math.PI / 2, 0, 0]}')
    expect(basketballGoal).toContain('<subtract id="rim"')
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-skeleton')?.content).toContain(
      geometryAuthoringSkeletonCode.trim(),
    )
  })

  it('keeps only non-database Geometry entries in the checked-in catalog knowledge', () => {
    expect(catalogDocsKnowledge.find(({ id }) => id === 'geometry:box')?.content).toContain('<box size=')
    expect(catalogDocsKnowledge.find(({ id }) => id === 'geometry:box')?.content).toContain('Origin:')
    expect(catalogDocsKnowledge.find(({ id }) => id === 'geometry:box')?.content).toContain('Properties:')
    expect(catalogDocsKnowledge.some(({ section }) => section === 'materials')).toBe(false)
    expect(catalogDocsKnowledge.some(({ section }) => section === 'quantity-kinds')).toBe(false)
  })

  it('ranks exact keys first and accepts a combined current and recent prompt query', () => {
    const serverResults = catalogSearchKnowledge([
      {
        kind: 'materialParameter',
        key: 'electrical.conductivity',
        title: 'electrical.conductivity',
        subtitle: 'electromagnetism.ElectricConductivity',
      },
    ])
    expect(searchDocsKnowledge('electrical.conductivity', [...getDocsKnowledge(), ...serverResults])[0]?.id).toBe(
      'materialParameter:electrical.conductivity',
    )

    const combinedResults = searchDocsKnowledge('Joule heating 이전 질문은 multiphysics')
    expect(combinedResults.slice(0, 3).map(({ id }) => id)).toContain('program-multiphysics-example')
  })

  it('searches Manual headings and keywords without indexing every body sentence', () => {
    expect(searchDocsKnowledge('invalid_unit').map(({ id }) => id)).toContain('troubleshooting-units-materials')
    expect(searchDocsKnowledge('폐기됩니다')).toEqual([])
  })

  it('prioritizes a prefix match from any keyword', () => {
    const chunks = [
      {
        ...manualDocsKnowledge[0],
        id: 'body-match',
        title: 'A body match',
        summary: 'prefix needle appears here',
        keywords: [],
      },
      {
        ...manualDocsKnowledge[0],
        id: 'later-keyword-prefix',
        title: 'Z keyword match',
        summary: '',
        keywords: ['first', 'prefix-keyword'],
      },
    ]

    expect(searchDocsKnowledge('prefix', chunks)[0]?.id).toBe('later-keyword-prefix')
  })

  it('turns API search rows into stable deep links without copying solver descriptors', () => {
    const [solver] = catalogSearchKnowledge([
      { kind: 'solver', key: 'dc-current-density@0.1.0', title: 'DC current density', subtitle: 'Solver' },
    ])

    expect(solver.id).toBe('solver:dc-current-density@0.1.0')
    expect(solver.href).toBe('/docs?section=solvers&item=dc-current-density%400.1.0')
    expect(getDocsKnowledge()).toHaveLength(manualDocsKnowledge.length + catalogDocsKnowledge.length)
  })
})
