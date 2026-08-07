import { renderToStaticMarkup } from 'react-dom/server'
import { measurements, primitives } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import JscadViewer, { ViewerToolbar } from './JscadViewer'
import { createLayerRenderParts, materialGridPartsFromLayers, scaleViewerLayers } from './sourceLayers'

const idleSolverProcess = {
  runId: null,
  status: 'idle',
  engine: { name: 'dc-current-density', version: '1.0.0' },
  stage: null,
  error: null,
  startedAt: null,
  finishedAt: null,
} as const

describe('JscadViewer modes', () => {
  it('defaults to the Geometry tab and exposes the shared render panel', () => {
    const markup = renderToStaticMarkup(
      <JscadViewer
        lengthUnit="mm"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
        layers={[]}
      />,
    )

    expect(markup).toContain('aria-label="Viewer modes"')
    expect(markup).toMatch(
      /<button[^>]*aria-selected="true"[^>]*id="viewer-geometry-tab"[^>]*role="tab"[^>]*tabindex="0"/,
    )
    expect(markup).toMatch(
      /<button[^>]*aria-selected="false"[^>]*id="viewer-material-grid-tab"[^>]*role="tab"[^>]*tabindex="-1"/,
    )
    expect(markup).toMatch(/aria-labelledby="viewer-geometry-tab"[^>]*id="viewer-render-panel"[^>]*role="tabpanel"/)
    expect(markup).toContain('aria-label="Camera views"')
    expect(markup).toContain('aria-label="Set default camera view"')
    expect(markup).toContain('aria-label="Set x camera view"')
    expect(markup).toContain('aria-label="Set y camera view"')
    expect(markup).toContain('aria-label="Set z camera view"')
    expect(markup).not.toContain('id="material-grid-spacing"')
  })

  it('shows spacing controls and requested/applied spacing for Material Grid', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        gridError={null}
        gridResult={{
          candidatePointCount: 100,
          colors: new Float32Array(48),
          effectiveSpacing: 0.25,
          positions: new Float32Array(36),
          requestedSpacing: 0.1,
          visiblePointCount: 12,
        }}
        gridStatus="ready"
        mode="material-grid"
        spacingDraft="0.1"
        spacingError={null}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-selected="true"[^>]*id="viewer-material-grid-tab"/)
    expect(markup).toContain('id="material-grid-spacing"')
    expect(markup).toContain('value="0.1"')
    expect(markup).toContain('>Apply</button>')
    expect(markup).toContain('Spacing (m)')
    expect(markup).toContain('12 points · requested 0.1 m · applied 0.25 m')
  })

  it('marks invalid spacing and reports a local validation message', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        mode="material-grid"
        spacingDraft="0"
        spacingError="Enter a positive finite spacing value."
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
      />,
    )

    expect(markup).toMatch(/<input[^>]*aria-describedby="material-grid-spacing-error"[^>]*aria-invalid="true"/)
    expect(markup).toContain('role="alert">Enter a positive finite spacing value.</div>')
  })

  it('shows enabled source toggles only for available documents', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        availableSources={['structure']}
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        mode="geometry"
        spacingDraft="1"
        spacingError={null}
        visibleSources={['structure']}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
        onToggleSource={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-label="Toggle structure"[^>]*aria-pressed="true"/)
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*aria-pressed="false"[^>]*disabled/)
  })

  it('adds the conditional Results tab and hides geometry-only controls in Results mode', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        availableSources={['structure', 'experiment']}
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        hasResults
        mode="results"
        spacingDraft="1"
        spacingError={null}
        visibleSources={['structure', 'experiment']}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
        onToggleSource={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-selected="true"[^>]*id="viewer-results-tab"/)
    expect(markup).not.toContain('aria-label="Viewer sources"')
    expect(markup).not.toContain('aria-label="Camera views"')
    expect(markup).not.toContain('id="material-grid-spacing"')
  })

  it('shows the exact solver identity and an enabled manual Run action', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        mode="geometry"
        spacingDraft="1"
        spacingError={null}
        simulation={{
          canRun: true,
          cancel: () => undefined,
          process: idleSolverProcess,
          run: () => null,
          stale: false,
        }}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
      />,
    )

    expect(markup).toContain('dc-current-density@1.0.0')
    expect(markup).toContain('aria-label="Simulation status: idle"')
    const runButton = markup.match(/<button[^>]*aria-label="Run simulation"[^>]*>/)?.[0]
    expect(runButton).toBeDefined()
    expect(runButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  it('replaces Run with Cancel while active and exposes failed stale state without discarding the toolbar', () => {
    const runningMarkup = renderToStaticMarkup(
      <ViewerToolbar
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        mode="geometry"
        spacingDraft="1"
        spacingError={null}
        simulation={{
          canRun: false,
          cancel: () => undefined,
          process: {
            runId: 'solver-1',
            status: 'running',
            engine: { name: 'dc-current-density', version: '1.0.0' },
            stage: 'solve',
            error: null,
            startedAt: 1,
            finishedAt: null,
          },
          run: () => null,
          stale: true,
        }}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
      />,
    )
    expect(runningMarkup).toContain('aria-label="Cancel simulation"')
    expect(runningMarkup).not.toContain('aria-label="Run simulation"')
    expect(runningMarkup).toContain('>Stale</span>')

    const failedMarkup = renderToStaticMarkup(
      <ViewerToolbar
        gridError={null}
        gridResult={null}
        gridStatus="idle"
        mode="geometry"
        spacingDraft="1"
        spacingError={null}
        simulation={{
          canRun: true,
          cancel: () => undefined,
          process: {
            runId: 'solver-1',
            status: 'failed',
            engine: { name: 'dc-current-density', version: '1.0.0' },
            stage: null,
            error: 'Material conductivity is missing.',
            startedAt: 1,
            finishedAt: 2,
          },
          run: () => null,
          stale: true,
        }}
        onApplySpacing={() => undefined}
        onChangeSpacing={() => undefined}
        onSetCameraView={() => undefined}
        onSelectMode={() => undefined}
      />,
    )
    expect(failedMarkup).toContain('aria-label="Simulation status: failed"')
    expect(failedMarkup).toContain('role="alert">Material conductivity is missing.</div>')
    expect(failedMarkup).toContain('max-h-16 w-full overflow-auto')
    expect(failedMarkup).toContain('aria-label="Run simulation"')
  })

  it('keeps Geometry selected when recorded data becomes available', () => {
    const markup = renderToStaticMarkup(
      <JscadViewer
        lengthUnit="mm"
        layers={[]}
        recordedData={{ 'Total current': { value: 14.9 } }}
        recordedDataRules={[
          {
            target: ['structure.geometry.conductor'],
            label: 'Total current',
            methodId: 'dc.total-current',
            parameters: {},
            result: {
              dtype: 'float64',
              unit: 'A',
              quantityKind: 'electromagnetism.ElectricCurrent',
            },
          },
        ]}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-selected="true"[^>]*id="viewer-geometry-tab"/)
    expect(markup).toMatch(/<button[^>]*aria-selected="false"[^>]*id="viewer-results-tab"/)
  })
})
describe('JscadViewer source layers', () => {
  const structurePart = {
    id: 'shared',
    geometry: {},
    material: { name: 'Structure', variables: { color: '#2563eb' } },
    surfaces: [],
  }
  const experimentPart = {
    id: 'shared',
    geometry: {},
    material: { name: 'Experiment', variables: { color: '#dc2626' } },
    surfaces: [],
  }

  it('preserves source Material colors when Geometry IDs collide', () => {
    const parts = createLayerRenderParts([
      { documentType: 'experiment', lengthUnit: 'mm', parts: [experimentPart] },
      { documentType: 'structure', lengthUnit: 'mm', parts: [structurePart] },
    ])

    expect(parts[0].color).toEqual([220 / 255, 38 / 255, 38 / 255, 1])
    expect(parts[1].color).toEqual([37 / 255, 99 / 255, 235 / 255, 1])
  })

  it('orders Experiment before Structure so Structure wins Material Grid overlap', () => {
    expect(
      materialGridPartsFromLayers([
        { documentType: 'structure', lengthUnit: 'mm', parts: [structurePart] },
        { documentType: 'experiment', lengthUnit: 'mm', parts: [experimentPart] },
      ]),
    ).toEqual([experimentPart, structurePart])
  })

  it('scales mixed-unit layers into the display unit without changing source geometry', () => {
    const structureGeometry = primitives.cuboid({ size: [100, 10, 10] })
    const experimentGeometry = primitives.cuboid({ size: [0.1, 0.01, 0.01] })
    const layers = [
      {
        documentType: 'structure' as const,
        lengthUnit: 'mm',
        parts: [{ id: 'structure', geometry: structureGeometry, surfaces: [] }],
      },
      {
        documentType: 'experiment' as const,
        lengthUnit: 'm',
        parts: [{ id: 'experiment', geometry: experimentGeometry, surfaces: [] }],
      },
    ]

    const scaled = scaleViewerLayers(layers, 'mm')

    expect(measurements.measureBoundingBox(scaled[0].parts[0].geometry as never)).toEqual(
      measurements.measureBoundingBox(scaled[1].parts[0].geometry as never),
    )
    expect(scaled[0].parts[0].geometry).toBe(structureGeometry)
    expect(scaled[1].parts[0].geometry).not.toBe(experimentGeometry)
    expect(measurements.measureBoundingBox(experimentGeometry)).toEqual([
      [-0.05, -0.005, -0.005],
      [0.05, 0.005, 0.005],
    ])
  })
})

describe('JscadViewer Material legend', () => {
  it('shows filled, colorless, and unassigned entries with the matching swatch style', () => {
    const core = { name: 'Core', version: 'Kittel_1988', variables: { color: '#2563eb' } }
    const cladding = { name: 'Cladding', variables: {} }
    const markup = renderToStaticMarkup(
      <JscadViewer
        lengthUnit="mm"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
        layers={[
          {
            documentType: 'structure',
            lengthUnit: 'mm',
            parts: [
              { id: 'assembly.core-1', geometry: {}, material: core, surfaces: [] },
              { id: 'assembly.core-2', geometry: {}, material: core, surfaces: [] },
              { id: 'assembly.cladding', geometry: {}, material: cladding, surfaces: [] },
              { id: 'assembly.unassigned-1', geometry: {}, surfaces: [] },
              { id: 'assembly.unassigned-2', geometry: {}, surfaces: [] },
            ],
          },
        ]}
      />,
    )

    expect(markup.match(/Core/g)).toHaveLength(1)
    expect(markup.match(/Cladding/g)).toHaveLength(1)
    expect(markup.match(/Unassigned/g)).toHaveLength(1)
    expect(markup).toContain('background-color:#2563eb')
    expect(markup.match(/data-material-swatch="wireframe"/g)).toHaveLength(2)
    expect(markup).toContain('border-color:#475569')
    expect(markup).not.toContain('background-color:#3b82f6')
    expect(markup).not.toContain('Kittel_1988')
  })

  it('keeps distinct Material instances with the same symbol in separate rows', () => {
    const markup = renderToStaticMarkup(
      <JscadViewer
        lengthUnit="mm"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
        layers={[
          {
            documentType: 'structure',
            lengthUnit: 'mm',
            parts: [
              {
                id: 'assembly.first',
                geometry: {},
                material: { name: 'Core', variables: { color: '#2563eb' } },
                surfaces: [],
              },
              {
                id: 'assembly.second',
                geometry: {},
                material: { name: 'Core', variables: { color: '#dc2626' } },
                surfaces: [],
              },
            ],
          },
        ]}
      />,
    )

    expect(markup.match(/Core/g)).toHaveLength(2)
    expect(markup).toContain('background-color:#2563eb')
    expect(markup).toContain('background-color:#dc2626')
  })
})
