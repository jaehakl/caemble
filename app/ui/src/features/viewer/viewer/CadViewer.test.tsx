import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CadScene, RecordedDataRule } from '@/lib/cad'
import { defineTask, simulationProgramManifest } from '@/lib/cad/simulation'
import CadViewer from './CadViewer'
import { resolveCadViewerRecordedDataRules } from './recordedData'
import { resolveCadViewerContent } from './cadViewerContent'

const structureScene: CadScene = {
  lengthUnit: 'mm',
  parts: [{ id: 'structure-part', geometry: {}, surfaces: [] }],
  tree: { key: 'structure', label: 'Structure', children: [] },
  geometryGroups: [],
  surfaceGroups: [],
}

const experimentScene: CadScene = {
  lengthUnit: 'mm',
  parts: [{ id: 'experiment-part', geometry: {}, surfaces: [] }],
  tree: { key: 'experiment', label: 'Experiment', children: [] },
  geometryGroups: [],
  surfaceGroups: [],
}

const program = simulationProgramManifest(
  {
    electric: defineTask({ name: 'dc-current-density', version: '0.0.0' }, {}),
  },
  {
    measuredCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
  'async def simulate(*, sim, tasks, vars):\n    return None\n',
)

describe('CadViewer', () => {
  it('defaults available Structure and Experiment sources to visible', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={{ scene: experimentScene, variables: { duration: 1 } }}
        structure={{ scene: structureScene, variables: { width: 2 } }}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="3D CAD Viewer"')
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle structure"[^>]*aria-pressed="true"/)
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*aria-pressed="true"/)
    expect(markup).toContain('min-h-[360px] min-w-0 lg:min-h-0 lg:overflow-hidden')
  })

  it('disables a missing source toggle', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={null}
        structure={{ scene: null, variables: null }}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*disabled/)
    expect(markup).toContain('Waiting for model...')
  })

  it('builds Experiment then Structure layers and an explicit all-hidden state', () => {
    const visible = resolveCadViewerContent(
      { scene: structureScene, variables: { width: 2 } },
      { scene: experimentScene, variables: { duration: 1 } },
      true,
      true,
    )
    const hidden = resolveCadViewerContent(
      { scene: structureScene, variables: { width: 2 } },
      { scene: experimentScene, variables: { duration: 1 } },
      false,
      false,
    )

    expect(visible.visibleSources).toEqual(['structure', 'experiment'])
    expect(visible.layers.map((layer) => layer.documentType)).toEqual(['experiment', 'structure'])
    expect(visible.lengthUnit).toBe('mm')
    expect(hidden.visibleSources).toEqual([])
    expect(hidden.layers).toEqual([])
    expect(hidden.emptyMessage).toBe('All Structure and Experiment sources are hidden.')
  })

  it('prefers the Structure display unit while preserving each layer unit', () => {
    const meterExperimentScene = { ...experimentScene, lengthUnit: 'm' } as const
    const content = resolveCadViewerContent(
      { scene: structureScene, variables: {} },
      { scene: meterExperimentScene, variables: {} },
      true,
      true,
    )

    expect(content.lengthUnit).toBe('mm')
    expect(content.layers.map((layer) => layer.lengthUnit)).toEqual(['m', 'mm'])
    expect(meterExperimentScene.lengthUnit).toBe('m')
  })

  it('does not expose task artifacts as Results without a global RecordedData manifest', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={{ scene: experimentScene, variables: {} }}
        recordedData={{ currentDensity: { value: [1, 2, 3] } }}
        structure={null}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).not.toContain('id="viewer-results-tab"')
    expect(markup).not.toContain('currentDensity')
  })

  it('uses only Experiment-level RecordedData as the Results schema', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={{ scene: experimentScene, variables: {} }}
        recordedData={{
          measuredCurrent: { value: 14.9 },
          currentDensity: { value: [1, 2, 3] },
        }}
        simulation={{
          canRun: false,
          cancel: () => undefined,
          process: {
            runId: null,
            status: 'idle',
            engine: null,
            stage: null,
            error: null,
            startedAt: null,
            finishedAt: null,
          },
          program,
          run: () => null,
          stale: false,
        }}
        structure={null}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toContain('id="viewer-results-tab"')
    expect(markup).toContain('>Results</button>')
    expect(markup).not.toContain('currentDensity')
  })

  it('uses persisted rules instead of the current Experiment schema for historical data', () => {
    const historicalRules: readonly RecordedDataRule[] = [
      {
        label: 'historicalVoltage',
        methodId: 'simulation.record',
        parameters: {},
        result: {
          dtype: 'float64',
          quantityKind: 'electromagnetism.ElectricPotential',
          unit: 'V',
        },
        target: [],
      },
    ]

    expect(resolveCadViewerRecordedDataRules(historicalRules, program)).toBe(historicalRules)
    expect(resolveCadViewerRecordedDataRules(undefined, program).map((rule) => rule.label)).toEqual(['measuredCurrent'])
  })
})
