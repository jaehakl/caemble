import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createCadSourceDocument, type CadDocumentType } from '@/lib/cad'
import { StructureExperimentViewer } from './StructureExperimentViewer'
import { attachPreflightMetadata, useCadWorkspace } from './useCadWorkspace'
import type { SimulationCompatibilityIssue } from './simulationUiTypes'

function tabLabels(markup: string) {
  const tabList = markup.match(/<div[^>]*aria-label="Structure and Experiment panels"[^>]*>.*?<\/div>/)?.[0] ?? ''
  return [...tabList.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])
}

function ViewerHarness({
  activeDocumentType,
  experiment,
  experimentLineage,
  preflightIssues = [],
  structure,
  structureLineage,
  structureVarsPanel,
}: {
  activeDocumentType: CadDocumentType | null
  experiment?: string | null
  experimentLineage?: React.ReactNode
  preflightIssues?: readonly SimulationCompatibilityIssue[]
  structure?: string | null
  structureLineage?: React.ReactNode
  structureVarsPanel?: React.ReactNode
}) {
  const structureDocument = structure == null ? structure : createCadSourceDocument('structure', structure, 1)
  const experimentDocument = experiment == null ? experiment : createCadSourceDocument('experiment', experiment, 2)
  const workspace = useCadWorkspace(
    structureDocument,
    experimentDocument,
    () => undefined,
    () => undefined,
  )
  const visibleStructure =
    preflightIssues.length === 0
      ? workspace.structureDocument
      : attachPreflightMetadata(
          workspace.structureDocument,
          preflightIssues,
          workspace.structureDocument.evaluationTimeoutMs,
          workspace.structureDocument.setEvaluationTimeoutMs,
        )

  return (
    <StructureExperimentViewer
      activeDocumentType={activeDocumentType}
      experiment={experimentDocument}
      experimentDocument={workspace.experimentDocument}
      experimentLineage={experimentLineage}
      solverCompatibility={
        preflightIssues.length === 0
          ? workspace.simulation.compatibility
          : { status: 'incompatible', issues: preflightIssues }
      }
      structure={structureDocument}
      structureDocument={visibleStructure}
      structureLineage={structureLineage}
      structureVarsPanel={structureVarsPanel}
      onActiveDocumentTypeChange={() => undefined}
    />
  )
}

describe('StructureExperimentViewer', () => {
  it('renders source and simulation specification tabs from externally owned controllers', () => {
    const markup = renderToStaticMarkup(
      <ViewerHarness activeDocumentType="structure" experiment="experiment source" structure="structure source" />,
    )

    expect(tabLabels(markup)).toEqual(['Structure Source', 'Experiment Source', 'Solver Spec'])
    expect(markup).toContain('id="structure-source-panel" role="tabpanel"')
    expect(markup).not.toContain('Structure Tree')
    expect(markup).not.toContain('Experiment Tree')
    expect(markup).not.toContain('structure-tree-panel')
    expect(markup).not.toContain('experiment-tree-panel')
    expect(markup).not.toContain('data-viewer-canvas="true"')
    expect(markup).toContain('min-h-[360px] min-w-0 flex-col')
  })

  it('hides missing document tabs and selects the first available source', () => {
    const structureMarkup = renderToStaticMarkup(
      <ViewerHarness activeDocumentType="structure" structure="structure source" />,
    )
    const experimentMarkup = renderToStaticMarkup(
      <ViewerHarness activeDocumentType="experiment" experiment="experiment source" />,
    )

    expect(tabLabels(structureMarkup)).toEqual(['Structure Source'])
    expect(structureMarkup).toMatch(/<button[^>]*aria-selected="true"[^>]*id="structure-source-tab"/)
    expect(tabLabels(experimentMarkup)).toEqual(['Experiment Source', 'Solver Spec'])
    expect(experimentMarkup).toMatch(/<button[^>]*aria-selected="true"[^>]*id="experiment-source-tab"/)
  })

  it('adds optional lineage and Structure Vars tabs without changing the default tabs', () => {
    const structureMarkup = renderToStaticMarkup(
      <ViewerHarness
        activeDocumentType="structure"
        structure="structure source"
        structureLineage={<div>Lineage content</div>}
        structureVarsPanel={<div>Vars controls</div>}
      />,
    )
    const experimentMarkup = renderToStaticMarkup(
      <ViewerHarness
        activeDocumentType="experiment"
        experiment="experiment source"
        experimentLineage={<div>Experiment lineage content</div>}
      />,
    )

    expect(tabLabels(structureMarkup)).toEqual(['Structure Source', 'Structure Vars', '족보 보기'])
    expect(tabLabels(structureMarkup)).toHaveLength(3)
    expect(structureMarkup).toContain('id="structure-lineage-panel" role="tabpanel"')
    expect(tabLabels(experimentMarkup).slice(0, 2)).toEqual(['Experiment Source', '족보 보기'])
    const experimentTabs = tabLabels(experimentMarkup)
    expect(experimentTabs[experimentTabs.length - 1]).toBe('Solver Spec')
    expect(tabLabels(experimentMarkup)).toHaveLength(3)
    expect(experimentMarkup).toContain('id="experiment-lineage-panel" role="tabpanel"')
  })

  it('renders an empty state only for nullish sources and keeps Results out of workspace tabs', () => {
    const missingMarkup = renderToStaticMarkup(<ViewerHarness activeDocumentType={null} />)
    const emptySourceMarkup = renderToStaticMarkup(<ViewerHarness activeDocumentType="structure" structure="" />)
    const experimentMarkup = renderToStaticMarkup(
      <ViewerHarness activeDocumentType="experiment" experiment="experiment source" />,
    )

    expect(missingMarkup).toContain('No modeling source')
    expect(missingMarkup).not.toContain('role="tablist"')
    expect(tabLabels(emptySourceMarkup)).toEqual(['Structure Source'])
    expect(emptySourceMarkup).not.toContain('No modeling source')
    expect(tabLabels(experimentMarkup)).not.toContain('Result')
    expect(experimentMarkup).not.toContain('result-tab')
  })

  it('keeps a successful preview Ready and reports simulation incompatibility in the footer', () => {
    const markup = renderToStaticMarkup(
      <ViewerHarness
        activeDocumentType="structure"
        experiment="experiment source"
        preflightIssues={[
          {
            documentType: 'structure',
            path: 'tasks.electric.initializations[0].target[0]',
            message: 'references missing structure.geometry.conductor.',
          },
        ]}
        structure="structure source"
      />,
    )

    expect(markup).toContain('>Ready</span>')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Preview ready')
    expect(markup).toContain('Simulation incompatible')
    expect(markup).toContain('See Solver Spec for all compatibility issues.')
  })
})
