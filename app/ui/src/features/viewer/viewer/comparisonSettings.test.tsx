import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { BoxGridResult } from './BoxGridResult'
import { WorkbenchViewer, type WorkbenchViewerProps } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { calculateBoxGridView, type BoxGridViewRequest } from './boxGridViewData'
import {
  createComparisonSettings,
  ViewerComparisonContext,
  type ComparisonSettings,
  type ViewerComparison,
} from './comparisonSettings'

vi.mock('./ScalarPlot', () => ({
  ScalarPlot: (props: unknown) => <output data-testid="plot">{JSON.stringify(props)}</output>,
}))
vi.mock('./PointCloudPlot', () => ({ PlotProbe: () => null }))
vi.mock('./JscadViewer', () => ({ default: () => <div>3D scene</div> }))

function restoredSettings() {
  const settings = createComparisonSettings()
  settings.set('signal:box.kind', 'heatmap')
  settings.set('signal:box.axes', ['time', 'x'])
  settings.set('signal:box.reduce', { frequency: { method: 'mean' } })
  settings.set('signal:box.animation', 'off')
  return settings
}

function fixture(name: string, scale: number, times = 3, frequencies?: readonly number[], componentCount = 2) {
  const shape = [2, 2, 1, times, frequencies?.length ?? 2, frequencies ? 2 : 1, componentCount]
  const axisNames = ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component']
  const grid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components: componentCount === 3 ? ['x', 'y', 'z'] : componentCount === 1 ? ['value'] : ['a', 'b'],
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
    tensorOrder: componentCount === 3 ? 1 : 0,
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
  name = 'signal',
  scale = 1,
  times = 3,
  visible = true,
  suspended = false,
  frequencies,
  componentCount = 2,
}: {
  settings: ComparisonSettings
  name?: string
  scale?: number
  times?: number
  visible?: boolean
  suspended?: boolean
  componentCount?: number
  frequencies?: readonly [readonly number[], readonly number[]]
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const input = useMemo(
    () => [
      fixture(name, scale, times, frequencies?.[0], componentCount),
      fixture(name, scale * 10, times, frequencies?.[1], componentCount),
    ],
    [name, scale, times, frequencies, componentCount],
  )
  const contexts = useMemo(
    () =>
      ['preview', 'actual'].map((side): ViewerComparison => ({
        settings,
        item: name,
        side: side as ViewerComparison['side'],
        controlsHost: host,
        controlsOwner: side === 'actual',
        suspended,
        camera: { current: null },
      })),
    [settings, name, host, suspended],
  )
  return (
    <>
      <div ref={setHost} aria-label="Shared controls" />
      {visible &&
        contexts.map((context, index) => (
          <ViewerComparisonContext.Provider key={context.side} value={context}>
            <BoxGridResult
              key={name}
              name={name}
              {...input[index]}
              displayUnit="m"
              canOverlayGeometry={false}
              renderViewer={() => null}
            />
          </ViewerComparisonContext.Provider>
        ))}
    </>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(request: BoxGridViewRequest) {
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
  { label: 'complex vector', frequencies: [1, 2], componentCount: 3, animation: 'oscillation', component: 'magnitude' },
  { label: 'complex scalar', frequencies: [1, 2], componentCount: 1, animation: 'oscillation', component: 0 },
  { label: 'real scalar', frequencies: undefined, componentCount: 1, animation: 'off', component: 0 },
  { label: 'DC vector', frequencies: [0], componentCount: 3, animation: 'off', component: 'magnitude' },
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
    await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
    expect(settings.values.get('signal:box.kind')).toBe('cloud')
    expect(settings.values.get('signal:box.axes')).toEqual(['x', 'y', 'z'])
    expect(settings.values.get('signal:box.reduce')).toEqual({ frequency: { method: 'sum' } })
    expect(settings.values.get('signal:box.component')).toBe(component)
    expect(settings.values.get('signal:box.animation')).toBe(animation)
    expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
    expect(settings.values.get('signal:box.playing')).toBe(false)
    expect(settings.values.get('signal:box.overlay')).toBe(true)
    expect(settings.values.get('signal:box.geometryOpacity')).toBe(0.5)
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
  fireEvent.change(screen.getByLabelText('Animation 모드'), { target: { value: 'oscillation' } })
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  expect(settings.values.get('busy:actual')).toBe(true)
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'true'))
  expect(screen.getByLabelText('Animation 시간')).toHaveTextContent('1.25000e-1s')
  await complete()
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
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('Animation 모드'), { target: { value: 'oscillation' } })
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  expect(screen.getByLabelText('재생 구간 (s)')).toHaveValue(1)
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  await waitFor(() => {
    const plots = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).plot)
    expect(plots[0].values[0]).toBeCloseTo(Math.SQRT1_2 / 2)
    expect(plots[1].values[0]).toBeCloseTo(0)
  })
  vi.useFakeTimers()
  fireEvent.click(screen.getByText('재생', { selector: 'button' }))
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
  fireEvent.click(screen.getByText('재생', { selector: 'button' }))
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
  fireEvent.click(screen.getByLabelText('반복'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25)
  })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0.01)
  expect(settings.values.get('signal:box.playing')).toBe(false)
  fireEvent.change(screen.getByLabelText('frequency 집계'), { target: { value: 'index' } })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
  expect(screen.getByLabelText('재생 구간 (s)')).toHaveValue(1)
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.1' } })
  fireEvent.change(screen.getByLabelText('frequency index'), { target: { value: '1' } })
  expect(settings.values.get('signal:box.timeSeconds')).toBe(0)
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
  expect(screen.getByRole('option', { name: '진동 · 공통 시간' })).not.toBeDisabled()
  fireEvent.change(screen.getByLabelText('frequency 집계'), { target: { value: 'index' } })
  await waitFor(() => expect(screen.getByRole('option', { name: '진동 · 공통 시간' })).toBeDisabled())
})

it('shares one toolbar, retains settings through replacement and remount, and computes independent automatic ranges', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  expect(screen.getAllByLabelText('시각화 도구모음')).toHaveLength(1)
  const ranges = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)
  expect(ranges[1][1]).toBeCloseTo(ranges[0][1] * 10)
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('표시 축 1'), { target: { value: 'y' } })
  fireEvent.click(screen.getByLabelText('값 범위 고정'))
  fireEvent.change(screen.getByLabelText('범위 최솟값'), { target: { value: '-5' } })
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '25' } })
  view.rerender(<Pair settings={settings} scale={2} />)
  await waitFor(() =>
    expect(
      screen.getAllByTestId('plot').every((node) => JSON.stringify(JSON.parse(node.textContent!).range) === '[-5,25]'),
    ).toBe(true),
  )
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  expect(screen.getByLabelText('표시 축 1')).toHaveValue('y')
  view.rerender(<Pair settings={settings} visible={false} />)
  view.rerender(<Pair settings={settings} name="other" />)
  expect(screen.getByLabelText('값 범위 고정')).not.toBeChecked()
  view.rerender(<Pair settings={settings} />)
  expect(screen.getByLabelText('범위 최솟값')).toHaveValue(-5)
  expect(screen.getByLabelText('성분')).toHaveValue('1')
})

it('keeps an out-of-range frame unchanged and resumes the same settings when compatible data returns', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('표시 축 1'), { target: { value: 'y' } })
  fireEvent.change(screen.getByLabelText('Animation 모드'), { target: { value: 'time' } })
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '2' } })
  view.rerender(<Pair settings={settings} times={1} />)
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
  expect(settings.values.get('signal:box.frameIndex')).toBe(2)
  expect(screen.queryAllByTestId('plot')).toHaveLength(0)
  view.rerender(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  expect(screen.getByLabelText('Animation 프레임')).toHaveValue('2')
})

it('advances shared playback only once and pauses without resetting during refresh', async () => {
  const settings = restoredSettings()
  const view = render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('표시 축 1'), { target: { value: 'y' } })
  fireEvent.change(screen.getByLabelText('Animation 모드'), { target: { value: 'time' } })
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  vi.useFakeTimers()
  fireEvent.click(screen.getByText('재생', { selector: 'button' }))
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
    viewerExpanded: false,
    showToolbar: false,
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
      settings: restoredSettings(),
      item: 'signal',
      side: 'actual',
      controlsHost: screen.getByTestId('toolbar-host'),
      controlsOwner: true,
      suspended: false,
      camera: { current: null },
    },
  }
  const view = render(<WorkbenchViewer {...props} />)
  await waitFor(() => expect(screen.getByTestId('plot')).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  fireEvent.click(screen.getByLabelText('값 범위 고정'))
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '123' } })
  view.rerender(<WorkbenchViewer {...props} recordedData={undefined} loading />)
  expect(screen.getByText('데이터 갱신 중… 설정을 유지합니다.')).toBeInTheDocument()
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  view.rerender(<WorkbenchViewer {...props} resultErrors={{ signal: 'Prediction failed' }} />)
  expect(screen.getByText('Prediction failed')).toBeInTheDocument()
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  view.rerender(<WorkbenchViewer {...props} recordedData={fixture('signal', 5).data} />)
  await waitFor(() => expect(screen.queryByText('Prediction failed')).not.toBeInTheDocument())
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  expect(screen.getByLabelText('성분')).toHaveValue('1')
})
