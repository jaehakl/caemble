import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ScalarPlotData } from '@/features/viewer/viewer/boxGridViewData'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CadViewerProps } from '@/features/viewer/viewer/CadViewer'
import { calculateBoxGridView, type BoxGridViewRequest } from '@/features/viewer/viewer/boxGridViewData'
import { viewerDisplayFixture, stressViewerFixture } from './viewerDisplay.fixture'
import { WorkbenchViewer } from './WorkbenchViewer'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import { createViewerSettings } from '@/features/viewer/viewer/comparisonSettings'
import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'

vi.mock('@/features/viewer/viewer/ScalarPlot', () => ({
  ScalarPlot: ({ plot, kind }: { plot: ScalarPlotData; kind: string }) => (
    <output data-testid="chart" data-kind={kind} data-axes={plot.axes.map((axis) => axis.name).join(',')} />
  ),
}))

vi.mock('@/features/viewer/viewer/CadViewer', () => ({
  default: (props: CadViewerProps) => (
    <output
      data-testid="scene"
      data-geometry={Boolean(props.experiment)}
      data-opacity={props.geometryOpacity}
      data-mesh={props.meshRenderData?.geometries.length ?? 0}
      data-rays={props.polylines?.length ?? 0}
      data-fields={props.heatmapRenderLayers?.length ?? 0}
      data-spatial-raster={Boolean(props.heatmapRenderLayers?.[0]?.raster)}
      data-maximum-x={props.meshRenderData?.bounds.max[0]}
      data-wireframes={
        props.meshRenderData?.geometries.filter((geometry) => geometry.primitive === 'lines').length ?? 0
      }
    />
  ),
}))

beforeEach(() =>
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(request: BoxGridViewRequest) {
        queueMicrotask(() => this.onmessage?.({ data: { result: calculateBoxGridView(request) } }))
      }
      terminate() {
        this.onmessage = null
      }
    },
  ),
)
afterEach(() => vi.unstubAllGlobals())

const defaults = {
  version: 2 as const,
  geometryMode: 0.9 as const,
  selectedOutput: 'signal',
  visualizations: { 'mesh-field': '@visualizations.sample.field', polyline: '@visualizations.sample.rays' },
  settings: { '@visualizations.sample.field:mesh.deformed': false },
  camera: null,
}

it.each([false, true])('renders stress and updates matching displacement (comparison=%s)', (comparison) => {
  const settings = createViewerSettings(stressViewerFixture().initialDefaults)
  const camera = createComparisonCamera()
  const show = (amount = 0.1) => (
    <>
      {(comparison ? (['preview', 'actual'] as const) : (['actual'] as const)).map((side) => (
        <WorkbenchViewer
          key={side}
          {...stressViewerFixture(amount)}
          comparison={
            comparison
              ? {
                  settings,
                  camera,
                  side,
                  item: '',
                  controlsOwner: side === 'actual',
                  controlsHost: null,
                  suspended: false,
                }
              : undefined
          }
        />
      ))}
    </>
  )
  const view = render(show())
  const scenes = () => screen.getAllByTestId('scene')
  const initial = Number(scenes()[0].dataset.maximumX)
  expect(initial).toBeGreaterThan(1)
  fireEvent.keyDown(screen.getByRole('button', { name: 'mesh-field · sample.stress' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByLabelText('변형 표시'))
  scenes().forEach((scene) => expect(Number(scene.dataset.maximumX)).toBeLessThan(initial))
  fireEvent.click(screen.getByLabelText('변형 표시'))
  view.rerender(show(0.4))
  scenes().forEach((scene) => expect(Number(scene.dataset.maximumX)).toBeGreaterThan(initial))
  fireEvent.change(screen.getByLabelText('Deformation result'), { target: { value: '' } })
  scenes().forEach((scene) => expect(Number(scene.dataset.maximumX)).toBeLessThan(initial))
  fireEvent.change(screen.getByLabelText('Deformation result'), { target: { value: '@visualizations.sample.field' } })
  scenes().forEach((scene) => expect(Number(scene.dataset.maximumX)).toBeGreaterThan(initial))
})

it('saves independent selections as v2 and restores them only on the first load', async () => {
  const props = viewerDisplayFixture()
  const update = vi.fn().mockResolvedValue({})
  const presentation = { experimentId: 7, measurementId: 3, hasInitialView: false, canSaveInitialView: true, update }
  const view = render(<WorkbenchViewer {...props} initialDefaults={defaults} presentation={presentation} />)
  fireEvent.click(screen.getByRole('button', { name: 'Geometry · 90%' }))
  fireEvent.keyDown(screen.getByRole('button', { name: 'ray · sample.rays' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitemradio', { name: '선택 안 함' }))
  view.rerender(<WorkbenchViewer {...props} initialDefaults={{ ...defaults }} presentation={presentation} />)
  expect(screen.getByRole('button', { name: 'Geometry · 50%' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'ray · 선택 안 함' })).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: '초기 화면·대표이미지' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitem', { name: '현재 화면을 초기 화면으로 저장' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      initialView: expect.objectContaining({
        version: 2,
        geometryMode: 0.5,
        selectedOutput: 'signal',
        measurementId: 3,
        visualizations: { 'mesh-field': '@visualizations.sample.field', polyline: '' },
      }),
    }),
  )
})

it('composes independent Geometry, Output, mesh and ray layers and cycles only Geometry opacity', async () => {
  render(<WorkbenchViewer {...viewerDisplayFixture()} initialDefaults={defaults} />)
  await waitFor(() => expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1'))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '1')
  expect(Number(screen.getByTestId('scene').dataset.mesh)).toBeGreaterThan(0)
  expect(screen.getByTestId('scene')).toHaveAttribute('data-geometry', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Geometry · 90%' }))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-opacity', '0.5')
  fireEvent.click(screen.getByRole('button', { name: 'Geometry · 50%' }))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-geometry', 'true')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '1')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-opacity', '0.9')
})

it('moves mesh controls into its persistent menu and applies deformation without clearing ray selection', async () => {
  render(<WorkbenchViewer {...viewerDisplayFixture()} initialDefaults={defaults} />)
  expect(screen.queryByLabelText('Mesh 경계선')).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: 'mesh-field · sample.field' }), { key: 'ArrowDown' })
  expect(screen.getByRole('menu')).toContainElement(screen.getByLabelText('Mesh 경계선'))
  fireEvent.click(screen.getByLabelText('Mesh 경계선'))
  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByTestId('scene')).toHaveAttribute('data-wireframes', '1') // load arrow remains
  fireEvent.click(screen.getByLabelText('변형 표시'))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '0')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-geometry', 'true')
  fireEvent.click(screen.getByLabelText('변형 표시'))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '1')
  fireEvent.click(screen.getByRole('radio', { name: '선택 안 함' }))
  expect(screen.queryByLabelText('Mesh 경계선')).not.toBeInTheDocument()
  expect(screen.getByTestId('scene')).toHaveAttribute('data-mesh', '0')
})

it('splits nonspatial Output below the shared scene and keeps explicit deselection through refresh', async () => {
  const props = viewerDisplayFixture()
  const view = render(<WorkbenchViewer {...props} initialDefaults={defaults} />)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Output · signal' }), { key: 'ArrowDown' })
  expect(screen.queryByRole('menuitemradio', { name: /Output/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'summary' }))
  expect(screen.getByRole('separator', { name: '3D와 Output 높이 조절' })).toHaveAttribute(
    'aria-orientation',
    'horizontal',
  )
  fireEvent.keyDown(screen.getByRole('button', { name: 'ray · sample.rays' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitemradio', { name: '선택 안 함' }))
  view.rerender(<WorkbenchViewer {...props} visualizations={{ ...props.visualizations }} initialDefaults={defaults} />)
  expect(screen.getByRole('button', { name: 'ray · 선택 안 함' })).toBeInTheDocument()
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '0')
})

it('isolates missing or incompatible visualization data without dropping valid siblings', async () => {
  const props = viewerDisplayFixture()
  const view = render(<WorkbenchViewer {...props} initialDefaults={defaults} />)
  await waitFor(() => expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1'))
  const rays = props.visualizations!.sample.rays
  view.rerender(<WorkbenchViewer {...props} initialDefaults={defaults} visualizations={{ sample: { rays } }} />)
  expect(screen.getByTestId('scene')).toHaveAttribute('data-mesh', '0')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '1')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1')
  view.rerender(
    <WorkbenchViewer
      {...props}
      initialDefaults={defaults}
      visualizations={{
        sample: {
          ...props.visualizations!.sample,
          rays: { ...rays, provenance: { ...rays.provenance, invocation: 99 } },
        },
      }}
    />,
  )
  expect(screen.getByText(/실행 이력이 달라/)).toBeInTheDocument()
  expect(screen.getByTestId('scene')).toHaveAttribute('data-rays', '0')
  expect(Number(screen.getByTestId('scene').dataset.mesh)).toBeGreaterThan(0)
})

it('keeps legacy mesh Output in the chart while native mesh visualization renders above', () => {
  const props = viewerDisplayFixture()
  const native = visualizationData({ sample: { field: props.visualizations!.sample.field } })
  const prefix = '@visualizations.sample.field'
  const outputRules = native.rules.map((rule) => ({ ...rule, label: rule.label.replace(prefix, 'meshOutput') }))
  const outputData = Object.fromEntries(
    Object.entries(native.data).map(([name, value]) => [
      name.replace(prefix, 'meshOutput'),
      isDataTensor(value) ? { ...value, provenance: props.visualizations!.sample.field.provenance } : value,
    ]),
  )
  render(
    <WorkbenchViewer
      {...props}
      recordedRules={[...props.recordedRules!, ...outputRules]}
      recordedData={{ ...props.recordedData, ...outputData }}
      resultContracts={{ ...props.resultContracts, meshOutput: native.contracts[prefix] }}
      initialDefaults={{
        ...defaults,
        selectedOutput: 'meshOutput',
        settings: { ...defaults.settings, 'meshOutput:mesh.deformed': false },
      }}
    />,
  )
  const both = Number(screen.getByTestId('scene').dataset.mesh)
  fireEvent.keyDown(screen.getByRole('button', { name: 'mesh-field · sample.field' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('radio', { name: '선택 안 함' }))
  expect(Number(screen.getByTestId('scene').dataset.mesh)).toBe(0)
  expect(screen.getByText(/이 Output은 XYZ point cloud/)).toBeInTheDocument()
  expect(both).toBeGreaterThan(0)
})

it('always splits, keeps Geometry on, and isolates Output chart settings in its menu', async () => {
  const props = viewerDisplayFixture()
  const view = render(<WorkbenchViewer {...props} initialDefaults={{ ...defaults, geometryMode: 0 }} />)
  expect(screen.getByRole('separator', { name: '3D와 Output 높이 조절' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Geometry · 90%' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1'))
  await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-kind', 'line'))
  expect(screen.queryByLabelText('frequency 역할')).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Output · signal' }), { key: 'ArrowDown' })
  const space = within(screen.getByRole('region', { name: '3D 설정' }))
  const chart = within(screen.getByRole('region', { name: '차트 설정' }))
  expect(space.queryByLabelText('x 역할')).not.toBeInTheDocument()
  expect(space.queryByRole('button', { name: 'Histogram' })).not.toBeInTheDocument()
  fireEvent.click(chart.getByRole('button', { name: 'Histogram' }))
  await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-kind', 'histogram'))
  expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '1')
  expect(screen.getByRole('menu')).toBeInTheDocument()
  view.rerender(<WorkbenchViewer {...props} resultVarsHash="different" initialDefaults={defaults} />)
  expect(screen.getByTestId('scene')).toHaveAttribute('data-geometry', 'true')
  expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '0')
  expect(screen.getAllByText(/Geometry와 결과의 Vars가 다릅니다/).length).toBeGreaterThan(0)
  expect(screen.getByTestId('chart')).toHaveAttribute('data-kind', 'histogram')
  fireEvent.click(screen.getByRole('menuitemradio', { name: '선택 안 함' }))
  expect(screen.getByRole('separator', { name: '3D와 Output 높이 조절' })).toBeInTheDocument()
  expect(screen.getByText('표시할 차트가 없습니다. Output을 선택하세요.')).toBeInTheDocument()
})

it('falls back to a spatial Heatmap for a plane and excludes data without spatial positions', async () => {
  const props = viewerDisplayFixture()
  const tensor = props.recordedData!.signal
  if (!isDataTensor(tensor)) throw new Error('Expected fixture tensor')
  const axes = [...tensor.axes!]
  axes[2] = { implicitOrdinal: true }
  const view = render(
    <WorkbenchViewer
      {...props}
      initialDefaults={defaults}
      recordedData={{ ...props.recordedData, signal: { ...tensor, axes } }}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('scene')).toHaveAttribute('data-spatial-raster', 'true'))
  axes[1] = { implicitOrdinal: true }
  view.rerender(
    <WorkbenchViewer
      {...props}
      initialDefaults={defaults}
      recordedData={{ ...props.recordedData, signal: { ...tensor, axes: [...axes] } }}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('scene')).toHaveAttribute('data-fields', '0'))
  expect(screen.getByText(/XYZ 좌표 또는 평면 배치 정보가 없어/)).toBeInTheDocument()
  expect(screen.getByTestId('chart')).toBeInTheDocument()
})
