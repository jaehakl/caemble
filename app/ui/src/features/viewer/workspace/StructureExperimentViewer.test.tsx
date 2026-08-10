import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle, type CadDocumentType } from '@/lib/cad'
import { StructureExperimentViewer } from './StructureExperimentViewer'
import { useCadWorkspace } from './useCadWorkspace'

function tabLabels(markup: string) {
  return [...markup.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])
}

function ViewerHarness({
  activeDocumentType,
  experiment,
  experimentLineage,
  structure,
}: {
  activeDocumentType: CadDocumentType | null
  experiment?: boolean
  experimentLineage?: React.ReactNode
  structure?: string
}) {
  const structureDocument = structure === undefined ? null : createCadSourceDocument('structure', structure, 1)
  const experimentDocument = experiment
    ? createCadSourceDocument(
        'experiment',
        createExperimentSourceBundle({
          'experiment.tsx': 'experiment',
          'simulate.py': 'simulate',
          'tasks/electric.tsx': 'task',
          'tasks/thermal.tsx': 'task',
        }),
        2,
      )
    : null
  const workspace = useCadWorkspace(structureDocument, experimentDocument, undefined, undefined)
  return (
    <StructureExperimentViewer
      activeDocumentType={activeDocumentType}
      experiment={experimentDocument}
      experimentDocument={workspace.experimentDocument}
      experimentLineage={experimentLineage}
      structure={structureDocument}
      structureDocument={workspace.structureDocument}
      onActiveDocumentTypeChange={() => undefined}
    />
  )
}

describe('StructureExperimentViewer', () => {
  it('orders Experiment first, Task tabs by name, and lineage last', () => {
    const markup = renderToStaticMarkup(
      <ViewerHarness
        activeDocumentType="experiment"
        experiment
        experimentLineage={<div>Lineage</div>}
        structure="structure"
      />,
    )
    expect(tabLabels(markup)).toEqual(['Structure', 'Experiment', 'electric', 'thermal', '족보 보기'])
    expect(markup).toContain('experiment.tsx')
    expect(markup).toContain('simulate.py')
    expect(markup).toContain('+ Task')
  })

  it('renders only available document tabs and an empty state for no sources', () => {
    expect(tabLabels(renderToStaticMarkup(<ViewerHarness activeDocumentType="structure" structure="" />))).toEqual([
      'Structure',
    ])
    expect(tabLabels(renderToStaticMarkup(<ViewerHarness activeDocumentType="experiment" experiment />))).toEqual([
      'Experiment',
      'electric',
      'thermal',
    ])
    expect(renderToStaticMarkup(<ViewerHarness activeDocumentType={null} />)).toContain('No modeling source')
  })
})
