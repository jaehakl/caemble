import { measurements, primitives } from '@jscad/modeling'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import JscadViewer, { ViewerToolbar } from './JscadViewer'
import { createLayerRenderParts, scaleViewerLayers } from './sourceLayers'

describe('geometry-only Viewer toolbar', () => {
  it('shows only camera and source visibility controls', () => {
    const onToggleSource = vi.fn()
    const markup = renderToStaticMarkup(
      <ViewerToolbar
        availableSources={['experiment', 'task']}
        viewerExpanded={false}
        visibleSources={['experiment']}
        onSetCameraView={() => undefined}
        onToggleSource={onToggleSource}
        onToggleViewerExpanded={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="Camera views"')
    expect(markup).toContain('aria-label="Set default camera view"')
    expect(markup).toContain('aria-label="Toggle experiment"')
    expect(markup).toContain('aria-label="Toggle task"')
    expect(markup).toContain('aria-label="Viewer 확장"')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).not.toContain('role="tab"')
    expect(markup).not.toContain('Material Grid')
    expect(markup).not.toContain('Results')
    expect(markup).not.toContain('Simulation')
  })

  it('exposes the restore action while the Viewer is expanded', () => {
    const markup = renderToStaticMarkup(
      <ViewerToolbar viewerExpanded onSetCameraView={() => undefined} onToggleViewerExpanded={() => undefined} />,
    )

    expect(markup).toContain('aria-label="Viewer 영역 복원"')
    expect(markup).toContain('aria-pressed="true"')
  })
})

describe('JscadViewer source layers', () => {
  const structurePart = {
    id: 'shared',
    geometry: {},
    materialRole: 'structure',
    material: { name: 'Structure', variables: { color: '#2563eb' } },
    surfaces: [],
  }
  const experimentPart = {
    id: 'shared',
    geometry: {},
    materialRole: 'experiment',
    material: { name: 'Experiment', variables: { color: '#dc2626' } },
    surfaces: [],
  }

  it('preserves source Material colors when Geometry IDs collide', () => {
    const parts = createLayerRenderParts([
      { source: 'task', lengthUnit: 'mm', parts: [experimentPart] },
      { source: 'experiment', lengthUnit: 'mm', parts: [structurePart] },
    ])

    expect(parts[0].color).toEqual([220 / 255, 38 / 255, 38 / 255, 1])
    expect(parts[1].color).toEqual([37 / 255, 99 / 255, 235 / 255, 1])
  })

  it('scales mixed-unit layers into the display unit without changing source geometry', () => {
    const structureGeometry = primitives.cuboid({ size: [100, 10, 10] })
    const experimentGeometry = primitives.cuboid({ size: [0.1, 0.01, 0.01] })
    const layers = [
      {
        source: 'experiment' as const,
        lengthUnit: 'mm',
        parts: [{ id: 'structure', geometry: structureGeometry, materialRole: 'structure', surfaces: [] }],
      },
      {
        source: 'task' as const,
        lengthUnit: 'm',
        parts: [{ id: 'experiment', geometry: experimentGeometry, materialRole: 'experiment', surfaces: [] }],
      },
    ]

    const scaled = scaleViewerLayers(layers, 'mm')

    expect(measurements.measureBoundingBox(scaled[0].parts[0].geometry as never)).toEqual(
      measurements.measureBoundingBox(scaled[1].parts[0].geometry as never),
    )
    expect(scaled[0].parts[0].geometry).toBe(structureGeometry)
    expect(scaled[1].parts[0].geometry).not.toBe(experimentGeometry)
  })
})

describe('JscadViewer Material legend', () => {
  it('deduplicates roles and shows explicit, automatic, and unresolved Material colors', () => {
    const core = { name: 'Core', variables: { color: '#2563eb' } }
    const markup = renderToStaticMarkup(
      <JscadViewer
        lengthUnit="mm"
        layers={[
          {
            source: 'experiment',
            lengthUnit: 'mm',
            parts: [
              { id: 'core-1', geometry: {}, materialRole: 'core', material: core, surfaces: [] },
              { id: 'core-2', geometry: {}, materialRole: 'core', material: core, surfaces: [] },
              {
                id: 'cladding',
                geometry: {},
                materialRole: 'cladding',
                material: { name: 'Cladding', variables: {} },
                surfaces: [],
              },
              { id: 'unresolved', geometry: {}, materialRole: 'tire', surfaces: [] },
            ],
          },
        ]}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup.match(/core: Core/g)).toHaveLength(1)
    expect(markup.match(/cladding: Cladding/g)).toHaveLength(1)
    expect(markup.match(/tire \(Unresolved\)/g)).toHaveLength(1)
    expect(markup).toContain('background-color:#2563eb')
    expect(markup.match(/data-material-swatch="fill"/g)).toHaveLength(3)
    expect(markup).not.toContain('Material Grid')
    expect(markup).not.toContain('Results')
  })
})
