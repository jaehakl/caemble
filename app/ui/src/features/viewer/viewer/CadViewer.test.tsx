import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CadScene } from '@/lib/cad'
import CadViewer from './CadViewer'
import { resolveCadViewerContent } from './cadViewerContent'

const taskScene: CadScene = {
  lengthUnit: 'mm',
  parts: [{ id: 'task-part', geometry: {}, materialRole: 'task', surfaces: [] }],
  tree: { key: 'task', label: 'Task', children: [] },
  geometryGroups: [],
  surfaceGroups: [],
}

const experimentScene: CadScene = {
  lengthUnit: 'mm',
  parts: [{ id: 'experiment-part', geometry: {}, materialRole: 'experiment', surfaces: [] }],
  tree: { key: 'experiment', label: 'Experiment', children: [] },
  geometryGroups: [],
  surfaceGroups: [],
}

describe('CadViewer', () => {
  it('defaults common Experiment and Task geometry to visible', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={{ scene: experimentScene, taskScenes: { electric: taskScene }, variables: { duration: 1 } }}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="3D CAD Viewer"')
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*aria-pressed="true"/)
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle task"[^>]*aria-pressed="true"/)
    expect(markup).not.toContain('role="tab"')
    expect(markup).not.toContain('Material Grid')
    expect(markup).not.toContain('Results')
    expect(markup).not.toContain('Run Simulation')
    expect(markup).toContain('min-h-[360px] min-w-0 lg:min-h-0 lg:overflow-hidden')
  })

  it('keeps common Experiment geometry visible without Tasks', () => {
    const experiment = { scene: experimentScene, taskScenes: {}, variables: {} }
    const content = resolveCadViewerContent(experiment, true, true)
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={experiment}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(content.availableSources).toEqual(['experiment'])
    expect(content.visibleSources).toEqual(['experiment'])
    expect(content.layers).toHaveLength(1)
    expect(content.layers[0].parts[0].id).toBe('experiment-part')
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*aria-pressed="true"/)
    expect(markup).toMatch(/<button[^>]*aria-label="Toggle task"[^>]*disabled/)
    expect(markup).not.toContain('No Experiment geometry is available.')
  })

  it('disables a missing source toggle', () => {
    const markup = renderToStaticMarkup(
      <CadViewer
        experiment={null}
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*aria-label="Toggle experiment"[^>]*disabled/)
    expect(markup).toContain('No Experiment geometry is available.')
  })

  it('builds common Experiment then Task layers and an explicit all-hidden state', () => {
    const visible = resolveCadViewerContent(
      { scene: experimentScene, taskScenes: { electric: taskScene }, variables: { duration: 1 } },
      true,
      true,
    )
    const hidden = resolveCadViewerContent(
      { scene: experimentScene, taskScenes: { electric: taskScene }, variables: { duration: 1 } },
      false,
      false,
    )

    expect(visible.visibleSources).toEqual(['experiment', 'task'])
    expect(visible.layers.map((layer) => layer.source)).toEqual(['experiment', 'task'])
    expect(visible.lengthUnit).toBe('mm')
    expect(hidden.visibleSources).toEqual([])
    expect(hidden.layers).toEqual([])
    expect(hidden.emptyMessage).toBe('All Experiment geometry layers are hidden.')
  })

  it('prefers the common Experiment display unit while preserving each layer unit', () => {
    const meterTaskScene = { ...taskScene, lengthUnit: 'm' } as const
    const content = resolveCadViewerContent(
      { scene: experimentScene, taskScenes: { electric: meterTaskScene }, variables: {} },
      true,
      true,
    )

    expect(content.lengthUnit).toBe('mm')
    expect(content.layers.map((layer) => layer.lengthUnit)).toEqual(['mm', 'm'])
    expect(meterTaskScene.lengthUnit).toBe('m')
  })
})
