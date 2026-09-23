import { createComparisonCamera } from './comparisonCamera'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { BoxGridResult } from './BoxGridResult'
import { ViewerDisplayControls } from './ViewerDisplayControls'
import { ViewerLayout } from './ViewerTools'
import { WorkbenchViewer, type WorkbenchViewerProps } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { calculateBoxGridView, type BoxGridViewRequest } from './boxGridViewData'
import {
  createComparisonSettings,
  ViewerComparisonContext,
  ViewerControls,
  type ComparisonSettings,
  type ViewerComparison,
} from './comparisonSettings'

vi.mock('./ScalarPlot', () => ({
  ScalarPlot: (props: unknown) => <output data-testid="plot">{JSON.stringify(props)}</output>,
}))
vi.mock('./JscadViewer', () => ({ default: () => <div>3D scene</div> }))
const projectionRequests: BoxGridViewRequest[] = []

function openPanel(name: string) {
  const button = screen.queryByRole('button', { name })
  if (!button) return
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
}
function openComponent() {
  const output = screen.getAllByRole('button', { name: /^Output ·/ })[0]
  if (output.getAttribute('aria-expanded') !== 'true') fireEvent.keyDown(output, { key: 'ArrowDown' })
}
function changeRole(axis: 'time' | 'frequency' | 'y', role: string) {
  const label = axis === 'time' ? 't' : axis === 'frequency' ? 'f' : axis
  openPanel(`${label} 축 역할`)
  fireEvent.change(screen.getByLabelText(`${axis} 역할`), { target: { value: role } })
}

function openChartAxes() {
  if (!screen.queryByRole('button', { name: 'x 주 축' }))
    fireEvent.keyDown(screen.getByRole('button', { name: /^Output ·/ }), { key: 'ArrowDown' })
}

function selectChartAxis(axis: 'x' | 'y' | 'z' | 't' | 'f', role: '주 축' | '보조축') {
  openChartAxes()
  fireEvent.click(screen.getByRole('button', { name: `${axis} ${role}` }))
}

function restoredSettings() {
  const settings = createComparisonSettings()
  settings.set('signal:box.kind', 'heatmap')
  settings.set('signal:box.axes', ['time', 'x'])
  settings.set('signal:box.reduce', { frequency: { method: 'mean' } })
  settings.set('signal:box.animation', 'off')
  return settings
}

function fixture(
  name: string,
  scale: number,
  times = 3,
  frequencies?: readonly number[],
  componentCount = 2,
  spatialShape: readonly [number, number, number] = [2, 2, 1],
) {
  const shape = [...spatialShape, times, frequencies?.length ?? 2, frequencies ? 2 : 1, componentCount]
  const axisNames = ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component']
  const grid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components:
      componentCount === 9
        ? ['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz']
        : componentCount === 6
          ? ['xx', 'yy', 'zz', 'xy', 'yz', 'xz']
          : componentCount === 3
            ? ['x', 'y', 'z']
            : componentCount === 1
              ? ['value']
              : ['a', 'b'],
    channels: frequencies ? ['amplitude', 'phase'] : ['value'],
    channelUnits: frequencies ? ['m', 'rad'] : ['m'],
    origin: [0, 0, 0],
    size: [1, 1, 1],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    lengthUnit: 'm',
    gridShape: [shape[0], shape[1], shape[2]],
    source: 'task',
    rootId: 'probe',
  }
  const result: RecordedDataRule['result'] & { tensorOrder: number } = {
    dtype: 'float64',
    quantityKind: 'Length',
    tensorOrder: componentCount === 9 || componentCount === 6 ? 2 : componentCount === 3 ? 1 : 0,
    unit: 'm',
    boxGrid: grid,
    axes: axisNames.map((name) => (name === 'frequency' ? { name, unit: 'Hz', quantityKind: 'Frequency' } : { name })),
  }
  const rules: RecordedDataRule[] = [{ label: name, methodId: 'stored', parameters: {}, target: [], result }]
  const data: RecordedData = {
    [name]: {
      shape,
      axes: shape.map((length, axis) => ({
        ticks:
          axis === 4 && frequencies
            ? [...frequencies]
            : Array.from({ length }, (_, index) => (axis < 3 ? (index + 0.5) / length : index)),
      })),
      boxGrid: grid,
      storage: {
        kind: 'inline',
        value: varsTensorFromFlat(
          Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, index) =>
            frequencies ? (Math.floor(index / componentCount) % 2 ? 0 : scale) : scale * (index + 1),
          ),
          shape,
        ),
      },
    },
  }
  return { rules, data }
}

function Pair({
  settings,
  role,
  name = 'signal',
  scale = 1,
  times = 3,
  visible = true,
  suspended = false,
  frequencies,
  componentCount = 2,
  spatialShape,
}: {
  settings: ComparisonSettings
  role?: 'space' | 'chart'
  name?: string
  scale?: number
  times?: number
  visible?: boolean
  suspended?: boolean
  componentCount?: number
  frequencies?: readonly [readonly number[], readonly number[]]
  spatialShape?: readonly [number, number, number]
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const input = useMemo(
    () => [
      fixture(name, scale, times, frequencies?.[0], componentCount, spatialShape),
      fixture(name, scale * 10, times, frequencies?.[1], componentCount, spatialShape),
    ],
    [name, scale, times, frequencies, componentCount, spatialShape],
  )
  const contexts = useMemo(
    () =>
      ['preview', 'actual'].map((side): ViewerComparison => ({
        settings,
        item: role ? `${name}@output-${role}` : name,
        side: side as ViewerComparison['side'],
        controlsHost: host,
        controlsOwner: side === 'actual',
        suspended,
        camera: createComparisonCamera(),
      })),
    [settings, name, host, suspended, role],
  )
  const views = (
    <>
      <div ref={setHost} aria-label="Shared controls" />
      {visible &&
        contexts.map((context, index) => (
          <ViewerComparisonContext.Provider key={context.side} value={context}>
            <BoxGridResult
              key={name}
              name={name}
              role={role}
              {...input[index]}
              displayUnit="m"
              canOverlayGeometry={false}
              renderViewer={() => null}
            />
          </ViewerComparisonContext.Provider>
        ))}
    </>
  )
  return (
    <ViewerLayout>
      <ViewerControls placement="data">
        <ViewerDisplayControls
          contracts={{}}
          output={name}
          onOutput={() => {}}
          geometry={0.9}
          onGeometry={() => {}}
          visualizations={{}}
          onVisualizations={() => {}}
          meshHost={() => {}}
        />
      </ViewerControls>
      {views}
    </ViewerLayout>
  )
}

beforeEach(() => {
  projectionRequests.length = 0
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(request: BoxGridViewRequest) {
        projectionRequests.push(request)
        const result = calculateBoxGridView(request)
        queueMicrotask(() => this.onmessage?.({ data: { result } }))
      }
      terminate() {
        this.onmessage = null
      }
    },
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([
  { label: 'complex vector', frequencies: [1, 2], componentCount: 3, animation: 'oscillation', component: 'arrows' },
  { label: 'complex scalar', frequencies: [1, 2], componentCount: 1, animation: 'oscillation', component: 0 },
  { label: 'real scalar', frequencies: undefined, componentCount: 1, animation: 'off', component: 0 },
  { label: 'DC vector', frequencies: [0], componentCount: 3, animation: 'off', component: 'arrows' },
])(
  'opens $label with XYZ points, frequency sum and no autoplay',
  async ({ frequencies, componentCount, animation, component }) => {
    const settings = createComparisonSettings()
    render(
      <Pair
        settings={settings}
        times={1}
        frequencies={frequencies ? [frequencies, frequencies] : undefined}
        componentCount={componentCount}
      />,
    )
    await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
    expect(settings.values.get('signal:box.kind')).toBe('cloud')
    expect(settings.values.get('signal:box.axes')).toEqual(['x', 'y', 'z'])
    expect(settings.values.get('signal:box.reduce')).toEqual({ frequency: { method: 'sum' } })
    expect(settings.values.get('signal:box.component')).toBe(component)
    expect(settings.values.get('signal:box.animation')).toBe(animation)
    expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
    expect(settings.values.get('signal:box.playing')).toBe(false)
    expect(settings.values.get('@workspace:geometryMode')).toBe(0.9)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  },
)

it('shows loading for initial and changed views but keeps frame calculations visually quiet', async () => {
  const pending: (() => void)[] = []
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(request: BoxGridViewRequest) {
        pending.push(() => this.onmessage?.({ data: { result: calculateBoxGridView(request) } }))
      }
      terminate() {
        this.onmessage = null
      }
    },
  )
  const settings = restoredSettings()
  const frequencies = [
    [1, 2],
    [4, 8],
  ] as const
  const view = render(<Pair settings={settings} times={1} frequencies={frequencies} />)
  const complete = async () => {
    await act(async () => {
      pending.splice(0).forEach((finish) => finish())
    })
  }
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
  openPanel('채널 축 역할')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  expect(settings.values.get('busy:actual:signal')).toBe(true)
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'true'))
  expect(screen.getByLabelText('Animation 시간')).toHaveTextContent('1.25000e-1 s')
  await complete()
  openComponent()
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
  view.rerender(<Pair settings={settings} times={1} frequencies={frequencies} scale={2} />)
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
})

it('synthesizes different frequency grids at one shared time and uses their combined playback range', async () => {
  const settings = restoredSettings()
  const frequencies = [
    [1, 2],
    [4, 8],
  ] as const
  const view = render(<Pair settings={settings} times={1} frequencies={frequencies} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  openComponent()
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  openPanel('채널 축 역할')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  expect(screen.getByLabelText('재생 구간 (s)')).toHaveValue(1)
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  await waitFor(() => {
    const plots = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).plot)
    expect(plots[0].values[0]).toBeCloseTo(Math.SQRT1_2 / 2)
    expect(plots[1].values[0]).toBeCloseTo(0)
  })
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: '시간 전개 재생' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBeCloseTo(0.125 + 1 / (20 * 8))
  view.rerender(<Pair settings={settings} times={1} frequencies={frequencies} suspended />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBeCloseTo(0.13125)
  view.rerender(<Pair settings={settings} times={1} frequencies={frequencies} />)
  fireEvent.change(screen.getByLabelText('재생 구간 (s)'), { target: { value: '0.01' } })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
  expect(settings.values.get('signal:box.playing')).toBe(false)
  fireEvent.change(screen.getByLabelText('재생 속도'), { target: { value: '4' } })
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '시간 전개 재생' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBeCloseTo(0.00625)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0.01)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
  fireEvent.click(within(screen.getByRole('region', { name: '채널 패널' })).getByRole('button', { name: '반복' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0.01)
  expect(settings.values.get('signal:box.playing')).toBe(false)
  changeRole('frequency', 'index')
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  expect(screen.getByLabelText('재생 구간 (s)')).toHaveValue(1)
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.1' } })
  fireEvent.change(screen.getByLabelText('frequency index'), { target: { value: '1' } })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  expect(screen.getByLabelText('재생 구간 (s)')).toHaveValue(0.5)
})

it('disables common-time playback when the selected frequency is DC in both panes', async () => {
  const settings = restoredSettings()
  render(
    <Pair
      settings={settings}
      times={1}
      frequencies={[
        [0, 1],
        [0, 2],
      ]}
    />,
  )
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  openPanel('채널 축 역할')
  expect(screen.getByRole('option', { name: '시간 전개' })).not.toBeDisabled()
  changeRole('frequency', 'index')
  await waitFor(() => expect(screen.getByRole('option', { name: '시간 전개' })).toBeDisabled())
})

it('shares one toolbar, retains settings through replacement and remount, and computes independent automatic ranges', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  expect(screen.getAllByLabelText('시각화 도구모음')).toHaveLength(1)
  const ranges = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)
  expect(ranges[1][1]).toBeCloseTo(ranges[0][1] * 10)
  openComponent()
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  changeRole('time', 'index')
  changeRole('y', 'space')
  fireEvent.click(screen.getByLabelText('값 범위 고정'))
  fireEvent.change(screen.getByLabelText('범위 최솟값'), { target: { value: '-5' } })
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '25' } })
  view.rerender(<Pair settings={settings} scale={2} />)
  await waitFor(() =>
    expect(
      screen.getAllByTestId('plot').every((node) => JSON.stringify(JSON.parse(node.textContent!).range) === '[-5,25]'),
    ).toBe(true),
  )
  openComponent()
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  expect(settings.values.get('signal:box.axes')).toEqual(['y', 'x'])
  view.rerender(<Pair settings={settings} visible={false} />)
  view.rerender(<Pair settings={settings} name="other" />)
  expect(screen.getByRole('button', { name: '값 범위 고정' })).toHaveAttribute('aria-pressed', 'false')
  view.rerender(<Pair settings={settings} />)
  expect(screen.getByLabelText('범위 최솟값')).toHaveValue(-5)
  openComponent()
  expect(screen.getByLabelText('성분')).toHaveValue('1')
})

it('keeps an out-of-range frame unchanged and resumes the same settings when compatible data returns', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  changeRole('time', 'index')
  changeRole('y', 'space')
  fireEvent.change(screen.getByLabelText('time index'), { target: { value: '2' } })
  view.rerender(<Pair settings={settings} times={1} />)
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
  expect(settings.values.get('signal:box.reduce')).toMatchObject({ time: { method: 'index', index: 2 } })
  expect(screen.queryAllByTestId('plot')).toHaveLength(0)
  view.rerender(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  expect(screen.getByLabelText('time index')).toHaveValue('2')
})

it('advances shared playback only once and pauses without resetting during refresh', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  changeRole('time', 'index')
  changeRole('y', 'space')
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 't 재생' }))
  await act(async () => {})
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
  view.rerender(<Pair settings={settings} suspended />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
  expect(settings.values.get('signal:box.playing')).toBe(true)
  view.rerender(<Pair settings={settings} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(2)
})

it('keeps toolbar settings while a Forward result is absent, fails, and recovers', async () => {
  render(<div data-testid="toolbar-host" />)
  const input = fixture('signal', 1)
  const props: WorkbenchViewerProps = {
    experiment: null,
    experimentDocument: {} as WorkbenchViewerProps['experimentDocument'],
    onFindSelectionSource: vi.fn(),
    onSelectionQueryChange: vi.fn(),
    onSelectionSourcePathsChange: vi.fn(),
    selectionQuery: null,
    selectionSourceStatus: {},
    showToolbar: true,
    selectedResult: 'signal',
    recordedData: input.data,
    recordedRules: input.rules,
    resultContracts: {
      signal: {
        task: 'probe',
        output: 'signal',
        solver: { name: 'fixture', version: '1' },
        artifactType: 'fixture',
        catalogRevision: 'fixture',
        schema: {},
        visualization: { kind: 'box-grid' },
      },
    },
    comparison: {
      settings: createComparisonSettings(
        Object.fromEntries(
          [...restoredSettings().values].map(([key, value]) => [key.replace('signal:', 'signal@output-chart:'), value]),
        ),
      ),
      item: 'signal',
      side: 'actual',
      controlsHost: screen.getByTestId('toolbar-host'),
      controlsOwner: true,
      suspended: false,
      camera: createComparisonCamera(),
    },
  }
  const view = render(<WorkbenchViewer {...props} />)
  await waitFor(() => expect(screen.getByTestId('plot')).toBeInTheDocument())
  fireEvent.keyDown(screen.getByRole('button', { name: 'Output · signal' }), { key: 'ArrowDown' })
  openComponent()
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  fireEvent.click(screen.getByLabelText('값 범위 고정'))
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '123' } })
  view.rerender(<WorkbenchViewer {...props} recordedData={undefined} loading />)
  expect(screen.getAllByText(/데이터 갱신 중… 설정을 유지합니다/)[0]).toBeInTheDocument()
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  view.rerender(<WorkbenchViewer {...props} resultErrors={{ signal: 'Prediction failed' }} />)
  expect(screen.getAllByText(/Prediction failed/)[0]).toBeInTheDocument()
  openComponent()
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  view.rerender(<WorkbenchViewer {...props} recordedData={fixture('signal', 5).data} />)
  await waitFor(() => expect(screen.queryByText(/Prediction failed/)).not.toBeInTheDocument())
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  openComponent()
  expect(screen.getByLabelText('성분')).toHaveValue('1')
})

it('normalizes incompatible saved indices once without dropping other shared display settings', async () => {
  const settings = createComparisonSettings({
    'signal:box.kind': 'heatmap',
    'signal:box.axes': ['time', 'x'],
    'signal:box.component': 99,
    'signal:box.geometryOpacity': 0.25,
    'signal:box.animation': 'time',
    'signal:box.frameIndex': 999,
    'signal:box.reduce': { frequency: { method: 'index', index: 999 } },
  })
  render(<Pair settings={settings} times={3} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  expect(settings.values.get('signal:box.component')).toBe('magnitude')
  expect(settings.values.get('signal:box.frameIndex')).toBe(0)
  expect(settings.values.get('signal:box.geometryOpacity')).toBe(0.25)
  expect(settings.values.get('signal:box.kind')).toBe('heatmap')
  expect(settings.values.get('signal:box.reduce')).toEqual({ frequency: { method: 'sum' } })
  expect(screen.queryAllByRole('alert')).toHaveLength(0)
})

it('preserves saved chart axes and maps them to heatmap rows and line series', async () => {
  const settings = createComparisonSettings({
    'signal@output-chart:box.axes': ['time', 'x'],
    'signal@output-chart:box.kind': 'heatmap',
  })
  render(<Pair role="chart" settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['time', 'x'])
  openChartAxes()
  expect(screen.getByRole('button', { name: 'x 주 축' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 't 보조축' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('button', { name: 'Histogram' })).not.toBeInTheDocument()
  expect(projectionRequests.some(({ options }) => options.axes.join(',') === 'time,x')).toBe(true)
  const heatmap = JSON.parse(screen.getAllByTestId('plot')[0].textContent!)
  expect(heatmap.kind).toBe('heatmap')
  expect(heatmap.plot.axes.map((axis: { name: string }) => axis.name)).toEqual(['time', 'x'])
  fireEvent.click(screen.getByRole('button', { name: 'Line Chart' }))
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['time', 'x'])
  const line = JSON.parse(screen.getAllByTestId('plot')[0].textContent!)
  expect(line.kind).toBe('line')
  expect(line.plot.axes.map((axis: { name: string }) => axis.name)).toEqual(['time', 'x'])
  expect(line.plot.shape).toEqual([3, 2])
})

it('swaps chart axes and lets a line omit its secondary axis without changing kind', async () => {
  const settings = createComparisonSettings()
  render(<Pair role="chart" settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['x', 'time'])
  selectChartAxis('x', '주 축')
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['time', 'x'])
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('heatmap')
  fireEvent.click(screen.getByRole('button', { name: 'Line Chart' }))
  selectChartAxis('t', '보조축')
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['x'])
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('line')
  openChartAxes()
  fireEvent.click(screen.getByRole('button', { name: 'Heatmap' }))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['time', 'x'])
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('heatmap')
})

it('keeps all five chart axis controls in the picker and shows reductions and index coordinates above the chart', async () => {
  const settings = createComparisonSettings()
  render(<Pair role="chart" settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(screen.queryByRole('button', { name: 'Line Chart' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('frequency 적분 방법')).not.toBeInTheDocument()
  openChartAxes()
  expect(screen.getAllByLabelText(/^[xyztf] 축 설정$/)).toHaveLength(5)
  expect(screen.getByRole('button', { name: 'Line Chart' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Heatmap' })).toBeInTheDocument()
  expect(screen.queryByLabelText('time 적분 방법')).not.toBeInTheDocument()
  expect(screen.getByLabelText('frequency 적분 방법')).toHaveValue('sum')
  fireEvent.change(screen.getByLabelText('frequency 적분 방법'), { target: { value: 'index' } })
  fireEvent.change(screen.getByLabelText('frequency index'), { target: { value: '1' } })
  expect(screen.queryByRole('button', { name: 'f 재생' })).not.toBeInTheDocument()
  expect(screen.getAllByLabelText('차트 축 설정')[0]).toHaveTextContent('f · 개별 index 1 · 1 Hz')
  expect(screen.getAllByLabelText('차트 축 설정')[0]).toHaveTextContent('y · mean')
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByLabelText('frequency 적분 방법')).not.toBeInTheDocument()
  expect(screen.getAllByLabelText('차트 축 설정')[0]).toHaveTextContent('f · 개별 index 1 · 1 Hz')
})

it('uses longest axes including singleton dimensions and restores saved Histogram as Heatmap', async () => {
  const settings = createComparisonSettings({ 'signal@output-chart:box.kind': 'histogram' })
  render(<Pair role="chart" settings={settings} times={1} spatialShape={[1, 1, 1]} frequencies={[[1], [1]]} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['y', 'x'])
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('heatmap')
  const plot = JSON.parse(screen.getAllByTestId('plot')[0].textContent!)
  expect(plot.kind).toBe('heatmap')
  expect(plot.plot.shape).toEqual([1, 1])
})

it('restores a single saved chart axis from Histogram as a line and copies that projection', async () => {
  const settings = createComparisonSettings({
    'signal@output-chart:box.axes': ['frequency'],
    'signal@output-chart:box.kind': 'histogram',
  })
  render(<Pair role="chart" settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.axes')).toEqual(['frequency'])
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('line')
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  fireEvent.click(screen.getByRole('button', { name: '변환 코드 복사' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
  expect(writeText.mock.calls[0][0]).toContain('boxGrid.project(record["signal"], {"axes":["frequency"]')
})

it('opens index controls on selection, toggles them with the icon, and preserves their coordinate', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  expect(screen.queryByRole('region', { name: 'f 축 패널' })).not.toBeInTheDocument()
  changeRole('frequency', 'index')
  fireEvent.change(screen.getByLabelText('frequency index'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'f 축 역할' }))
  expect(screen.queryByLabelText('frequency index')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'f 축 역할' }))
  expect(screen.getByLabelText('frequency index')).toHaveValue('1')
  fireEvent.change(screen.getByLabelText('frequency 역할'), { target: { value: 'sum' } })
  expect(screen.queryByRole('region', { name: 'f 축 패널' })).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'frequency 역할' })).toHaveValue('sum')
})

it('retains the last valid fixed range during invalid input and supports constant ranges', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '값 범위 고정' }))
  fireEvent.change(screen.getByLabelText('범위 최솟값'), { target: { value: '-1' } })
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('범위 최솟값'), { target: { value: '2' } })
  expect(screen.getByRole('alert')).toHaveTextContent('마지막 유효 범위')
  expect(settings.values.get('signal:box.fixed')).toEqual([-1, 1])
  fireEvent.change(screen.getByLabelText('범위 최솟값'), { target: { value: '1' } })
  expect(settings.values.get('signal:box.fixed')).toEqual([1, 1])
  expect(screen.getAllByLabelText('값 colorbar')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '값 범위 고정' }))
  expect(settings.values.get('signal:box.fixed')).toBeNull()
  expect(screen.queryByLabelText('값 colorbar')).not.toBeInTheDocument()
})

it('keeps spatial playback ranges stable without a component toolbar button', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  fireEvent.change(screen.getByLabelText('x 역할'), { target: { value: 'index' } })
  openComponent()
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  await waitFor(() => expect(settings.values.get('busy:actual:signal')).toBe(false))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'x 재생' }))
  await act(async () => {})
  const ranges = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
  expect(screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)).toEqual(ranges)
  expect(screen.queryByRole('button', { name: 'comp 재생' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'comp 축 역할' })).not.toBeInTheDocument()
})

it('shares Output playback between chart and 3D while advancing it once', async () => {
  const settings = createComparisonSettings()
  render(
    <>
      <section data-testid="space-pair">
        <Pair
          role="space"
          times={1}
          frequencies={[
            [1, 2],
            [4, 8],
          ]}
          settings={settings}
        />
      </section>
      <section data-testid="chart-pair">
        <Pair
          role="chart"
          times={1}
          frequencies={[
            [1, 2],
            [4, 8],
          ]}
          settings={settings}
        />
      </section>
    </>,
  )
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-space')).toBe(false))
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  const controls = within(screen.getByTestId('chart-pair'))
  if (!controls.queryByLabelText('Animation 프레임'))
    fireEvent.click(controls.getByRole('button', { name: '채널 축 역할' }))
  fireEvent.change(controls.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  await waitFor(() => expect(settings.values.get('busy:preview:signal@output-space')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.timeSeconds')).toBe(0.125)
  expect(settings.values.has('signal@output-space:box.timeSeconds')).toBe(false)
  vi.useFakeTimers()
  fireEvent.click(controls.getByRole('button', { name: '시간 전개 재생' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal@output-chart:box.timeSeconds')).toBeCloseTo(0.13125)
  expect(settings.values.has('signal@output-space:box.timeSeconds')).toBe(false)
})

it('uses chart controls for shared Box Grid values without changing 3D spatial axes', async () => {
  const settings = createComparisonSettings()
  render(
    <>
      <section data-testid="space-pair">
        <Pair role="space" settings={settings} />
      </section>
      <section data-testid="chart-pair">
        <Pair role="chart" settings={settings} />
      </section>
    </>,
  )
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  const chart = within(screen.getByTestId('chart-pair'))
  fireEvent.keyDown(chart.getByRole('button', { name: 'Output · signal' }), { key: 'ArrowDown' })
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  await waitFor(() =>
    expect(
      projectionRequests.some(({ options }) => options.axes.join(',') === 'x,y,z' && options.component === 1),
    ).toBe(true),
  )
  expect(settings.values.get('signal@output-chart:box.component')).toBe(1)
  expect(settings.values.has('signal@output-space:box.component')).toBe(false)
  projectionRequests.length = 0
  fireEvent.keyDown(chart.getByRole('button', { name: 'Output · signal' }), { key: 'ArrowDown' })
  fireEvent.change(screen.getByLabelText('frequency 적분 방법'), { target: { value: 'mean' } })
  await waitFor(() =>
    expect(
      projectionRequests.some(
        ({ options }) => options.axes.join(',') === 'x,y,z' && options.reduce?.frequency?.method === 'mean',
      ),
    ).toBe(true),
  )
  expect(projectionRequests.some(({ options }) => options.axes.join(',') === 'x,y,z')).toBe(true)
  expect(projectionRequests.some(({ options }) => options.axes.join(',') === 'x,time')).toBe(true)
})

it('selects vector components inside Output and disables magnitude choices for Phase', async () => {
  const settings = createComparisonSettings()
  render(<Pair role="chart" settings={settings} componentCount={3} frequencies={[[1], [1]]} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  openComponent()
  expect(screen.getByRole('button', { name: '벡터 화살표 |V|' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getAllByRole('button', { name: /^벡터 / })).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: '벡터 |V|²' }))
  expect(settings.values.get('signal@output-chart:box.component')).toBe('magnitudeSquared')
  await waitFor(() =>
    expect(projectionRequests.some(({ options }) => options.component === 'magnitudeSquared')).toBe(true),
  )
  expect(screen.getAllByTestId('plot')[0]).toHaveTextContent('"unit":"(m)²"')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'phase' } })
  expect(screen.getByRole('button', { name: '벡터 |V|²' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '벡터 화살표 |V|' })).toBeDisabled()
  expect(settings.values.get('signal@output-chart:box.component')).toBe(0)
  expect(screen.queryByRole('button', { name: 'comp 축 역할' })).not.toBeInTheDocument()
})

it('keeps tensor direction and magnitude selections in the Output panel', async () => {
  const settings = createComparisonSettings()
  render(<Pair role="chart" settings={settings} componentCount={9} frequencies={[[1], [1]]} />)
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  openComponent()
  expect(screen.getByRole('region', { name: 'Box Grid 성분 설정' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '텐서 1축 X' }))
  fireEvent.click(screen.getByRole('button', { name: '텐서 2축 Y' }))
  expect(settings.values.get('signal@output-chart:box.component')).toEqual({ tensor: ['x', 'y'] })
  await waitFor(() =>
    expect(projectionRequests.some(({ options }) => JSON.stringify(options.component) === '{"tensor":["x","y"]}')).toBe(
      true,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: '텐서 1축 화살표' }))
  expect(settings.values.get('signal@output-chart:box.component')).toEqual({ tensor: ['arrows', 'y'] })
  fireEvent.click(screen.getByRole('button', { name: '텐서 2축 |T|' }))
  expect(settings.values.get('signal@output-chart:box.component')).toEqual({ tensor: ['arrows', 'all'] })
  fireEvent.click(screen.getByRole('button', { name: '텐서 2축 화살표' }))
  expect(settings.values.get('signal@output-chart:box.component')).toEqual({ tensor: ['all', 'arrows'] })
  expect(screen.getByRole('button', { name: '텐서 1축 |T|' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'phase' } })
  expect(settings.values.get('signal@output-chart:box.component')).toBe(0)
  expect(screen.getByRole('button', { name: '텐서 1축 화살표' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '텐서 2축 |T|' })).toBeDisabled()
})

it('keeps a saved chart spatial frame without applying that animation to 3D', async () => {
  const settings = createComparisonSettings({
    'signal@output-chart:box.animation': 'x',
    'signal@output-chart:box.frameIndex': 1,
  })
  render(
    <>
      <Pair role="space" settings={settings} />
      <Pair role="chart" settings={settings} />
    </>,
  )
  await waitFor(() => expect(settings.values.get('busy:actual:signal@output-chart')).toBe(false))
  expect(settings.values.get('signal@output-chart:box.frameIndex')).toBe(1)
  expect(projectionRequests.some(({ options, sweepAxis }) => options.axes.join(',') === 'x,y,z' && !sweepAxis)).toBe(
    true,
  )
  expect(projectionRequests.some(({ sweepAxis }) => sweepAxis === 'x')).toBe(true)
})
