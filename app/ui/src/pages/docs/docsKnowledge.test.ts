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
    expect(
      manualDocsKnowledge
        .filter(({ section }) => section === 'workbench')
        .map(({ content }) => content)
        .join('\n'),
    ).not.toContain('복제')
    const quickstart = manualDocsKnowledge.find(({ id }) => id === 'workbench-quickstart')?.content
    expect(quickstart).toContain('**Generate & Run**')
    expect(quickstart).toContain('**Repeat Run**')
    expect(quickstart).toContain('N은 성공 횟수가 아니라 전체 시도 횟수')
    expect(quickstart).toContain('결과 저장 실패나 명시적 Cancel은 남은 반복을 중단')
    expect(quickstart).toContain('Prepared 상태로 남습니다')
  })

  it('documents the Analysis Explore ranking, readiness gates, and CSV scope', () => {
    const analysis = manualDocsKnowledge.find((chunk) => chunk.id === 'workbench-analysis')?.content ?? ''

    expect(analysis).toContain('|Pearson r|')
    expect(analysis).toContain('서로 다른 입력 5개 이상')
    expect(analysis).toContain('Data 설정에서 선택한 열만')
    expect(analysis).toContain('Worker에 캐시된 최종 모델')
  })

  it('links manual examples to canonical catalog detail instead of duplicating full source', () => {
    expect(manualDocsKnowledge.find(({ id }) => id === 'program-definition')?.content).toContain(
      'item=experiment:caemble:experiment/caemble/verified/dc-uniform-bar@1.0.0',
    )
    expect(manualDocsKnowledge.find(({ id }) => id === 'reference-geometry-skeleton')?.content).toContain(
      'item=experiment:caemble:experiment/caemble/getting-started/geometry-authoring-skeleton@1.0.0',
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
      {
        kind: 'experiment',
        key: 'caemble:experiment/caemble/getting-started/basketball-goal@1.0.0',
        title: 'Basketball Goal',
        subtitle: 'Example Experiment',
      },
      {
        kind: 'experiment',
        key: 'caemble:experiment/caemble/verified/dc-uniform-bar@1.0.0',
        title: 'DC Uniform Bar',
        subtitle: 'Example Experiment',
      },
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
    expect(serverResults[2].item).toBe('experiment:caemble:experiment/caemble/getting-started/basketball-goal@1.0.0')
    expect(serverResults[3].item).toBe('experiment:caemble:experiment/caemble/verified/dc-uniform-bar@1.0.0')
  })
})
