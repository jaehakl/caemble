import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createCadSourceDocument, type CadDocumentType } from '@/lib/cad'
import { defaultExperimentSimulationCode } from '@/lib/defaultExperimentSimulationCode'
import { StructureExperimentViewer } from './StructureExperimentViewer'
import { useCadWorkspace } from './useCadWorkspace'

function tabLabels(markup: string) {
  const tabList = markup.match(/<div[^>]*aria-label="Structure and Experiment panels"[^>]*>.*?<\/div>/)?.[0] ?? ''
  return [...tabList.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])
}

function ViewerHarness({
  activeDocumentType,
  experiment,
  experimentLineage,
  structure,
  structureLineage,
  structureVarsPanel,
}: {
  activeDocumentType: CadDocumentType | null
  experiment?: string | null
  experimentLineage?: React.ReactNode
  structure?: string | null
  structureLineage?: React.ReactNode
  structureVarsPanel?: React.ReactNode
}) {
  const structureDocument = structure == null ? structure : createCadSourceDocument('structure', structure, 1)
  const experimentDocument =
    experiment == null
      ? experiment
      : createCadSourceDocument('experiment', experiment, 2, defaultExperimentSimulationCode)
  const workspace = useCadWorkspace(
    structureDocument,
    experimentDocument,
    () => undefined,
    () => undefined,
  )
  return (
    <StructureExperimentViewer
      activeDocumentType={activeDocumentType}
      experiment={experimentDocument}
      experimentDocument={workspace.experimentDocument}
      experimentLineage={experimentLineage}
      structure={structureDocument}
      structureDocument={workspace.structureDocument}
      structureLineage={structureLineage}
      structureVarsPanel={structureVarsPanel}
      onActiveDocumentTypeChange={() => undefined}
    />
  )
}

describe('StructureExperimentViewer', () => {
  it('renders source tabs from externally owned controllers', () => {
    const markup = renderToStaticMarkup(
      <ViewerHarness activeDocumentType="structure" experiment="experiment source" structure="structure source" />,
    )

    expect(tabLabels(markup)).toEqual(['Structure Source', 'Experiment Source', 'Python simulate'])
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
    expect(tabLabels(experimentMarkup)).toEqual(['Experiment Source', 'Python simulate'])
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
    expect(tabLabels(experimentMarkup)).toEqual(['Experiment Source', 'Python simulate', '족보 보기'])
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
})
