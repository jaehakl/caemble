import { describe, expect, it } from 'vitest'
import { fetchCaeSolverManifests } from '@/features/cae/manifests'
import {
  buildSolverDocsKnowledge,
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
      new Set(['workbench', 'structure', 'program', 'reference', 'troubleshooting']),
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
  })

  it('derives searchable entries from every canonical catalog', () => {
    expect(catalogDocsKnowledge.find(({ id }) => id === 'geometry:box')?.content).toContain('<box size=')
    expect(catalogDocsKnowledge.find(({ id }) => id === 'materials:electrical.conductivity')?.content).toContain(
      'electromagnetism.ElectricConductivity',
    )
    expect(
      catalogDocsKnowledge.find(({ id }) => id === 'quantity-kinds:electromagnetism.ElectricCurrent')?.content,
    ).toContain('Applicable UCUM units:')
  })

  it('ranks exact keys first and accepts a combined current and recent prompt query', () => {
    expect(searchDocsKnowledge('electrical.conductivity')[0]?.id).toBe('materials:electrical.conductivity')

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

  it('builds solver knowledge directly from the deployed manifests', async () => {
    const manifests = await fetchCaeSolverManifests()
    const solverChunks = buildSolverDocsKnowledge(manifests)
    const dc = solverChunks.find(({ id }) => id === 'solvers:dc-current-density@0.0.0')

    expect(dc?.content).toContain('dc.current-density')
    expect(dc?.content).toContain('Material role')
    expect(getDocsKnowledge(manifests)).toHaveLength(
      manualDocsKnowledge.length + catalogDocsKnowledge.length + solverChunks.length,
    )
  })
})
