import { createComparisonCamera } from './comparisonCamera'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
vi.mock('./JscadViewer', () => ({ default: () => <div>3D scene</div> }))

function openPanel(name: string) {
  const button = screen.queryByRole('button', { name })
  if (!button) return
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
}
function changeRole(axis: 'time' | 'frequency' | 'y', role: string) {
  const label = axis === 'time' ? 't' : axis === 'frequency' ? 'f' : axis
  openPanel(`${label} 축 역할`)
  fireEvent.change(screen.getByLabelText(`${axis} 역할`), { target: { value: role } })
}

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
        camera: createComparisonCamera(),
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
  openPanel('채널 축 역할')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'false'))
  await complete()
  fireEvent.change(screen.getByLabelText('Animation 프레임'), { target: { value: '0.125' } })
  expect(settings.values.get('busy:actual')).toBe(true)
  screen.getAllByText('계산 중…').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'true'))
  expect(screen.getByLabelText('Animation 시간')).toHaveTextContent('1.25000e-1 s')
  await complete()
  openPanel('comp 축 역할')
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
  openPanel('comp 축 역할')
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  openPanel('채널 축 역할')
  fireEvent.change(screen.getByLabelText('채널'), { target: { value: 'oscillation' } })
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
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
  openPanel('comp 축 역할')
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
  openPanel('comp 축 역할')
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  expect(settings.values.get('signal:box.axes')).toEqual(['y', 'x'])
  view.rerender(<Pair settings={settings} visible={false} />)
  view.rerender(<Pair settings={settings} name="other" />)
  expect(screen.getByRole('button', { name: '값 범위 고정' })).toHaveAttribute('aria-pressed', 'false')
  view.rerender(<Pair settings={settings} />)
  expect(screen.getByLabelText('범위 최솟값')).toHaveValue(-5)
  openPanel('comp 축 역할')
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
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
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
      camera: createComparisonCamera(),
    },
  }
  const view = render(<WorkbenchViewer {...props} />)
  await waitFor(() => expect(screen.getByTestId('plot')).toBeInTheDocument())
  openPanel('comp 축 역할')
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '1' } })
  fireEvent.click(screen.getByLabelText('값 범위 고정'))
  fireEvent.change(screen.getByLabelText('범위 최댓값'), { target: { value: '123' } })
  view.rerender(<WorkbenchViewer {...props} recordedData={undefined} loading />)
  expect(screen.getByText('데이터 갱신 중… 설정을 유지합니다.')).toBeInTheDocument()
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  view.rerender(<WorkbenchViewer {...props} resultErrors={{ signal: 'Prediction failed' }} />)
  expect(screen.getByText('Prediction failed')).toBeInTheDocument()
  openPanel('comp 축 역할')
  expect(screen.getByLabelText('성분')).toHaveValue('1')
  view.rerender(<WorkbenchViewer {...props} recordedData={fixture('signal', 5).data} />)
  await waitFor(() => expect(screen.queryByText('Prediction failed')).not.toBeInTheDocument())
  expect(screen.getByLabelText('범위 최댓값')).toHaveValue(123)
  openPanel('comp 축 역할')
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
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  expect(settings.values.get('signal:box.component')).toBe('magnitude')
  expect(settings.values.get('signal:box.frameIndex')).toBe(0)
  expect(settings.values.get('signal:box.geometryOpacity')).toBe(0.25)
  expect(settings.values.get('signal:box.kind')).toBe('heatmap')
  expect(settings.values.get('signal:box.reduce')).toEqual({ frequency: { method: 'sum' } })
  expect(screen.queryAllByRole('alert')).toHaveLength(0)
})

it('changes visualization with axis roles and shows a raw histogram with a reduced marker at zero axes', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(2))
  changeRole('time', 'index')
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  expect(settings.values.get('signal:box.kind')).toBe('line')
  expect(settings.values.get('signal:box.axes')).toEqual(['x'])
  fireEvent.change(screen.getByLabelText('x 역할'), { target: { value: 'sum' } })
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  expect(settings.values.get('signal:box.kind')).toBe('histogram')
  const plots = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!))
  expect(plots[0].plot.values).toHaveLength(24)
  expect(plots[0].histogramMarker).toBeGreaterThan(0)
  expect(plots[1].histogramMarker).toBeCloseTo(plots[0].histogramMarker * 10)
  expect(screen.queryByLabelText('표본 조회')).not.toBeInTheDocument()
})

it('opens index controls on selection, toggles them with the icon, and preserves their coordinate', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
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
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
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

it('switches index playback between spatial and component axes with stable ranges and pauses on panel close', async () => {
  const settings = restoredSettings()
  render(<Pair settings={settings} />)
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  fireEvent.change(screen.getByLabelText('x 역할'), { target: { value: 'index' } })
  fireEvent.change(screen.getByLabelText('성분'), { target: { value: '0' } })
  await waitFor(() => expect(settings.values.get('busy:actual')).toBe(false))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'x 재생' }))
  await act(async () => {})
  const ranges = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
  expect(screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)).toEqual(ranges)
  fireEvent.click(screen.getByRole('button', { name: 'comp 재생' }))
  await act(async () => {})
  expect(settings.values.get('signal:box.animation')).toBe('component')
  expect(settings.values.get('signal:box.reduce')).toMatchObject({ x: { method: 'index', index: 1 } })
  expect(screen.queryByRole('button', { name: 'x 일시정지' })).not.toBeInTheDocument()
  const componentRanges = screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
  expect(screen.getAllByTestId('plot').map((node) => JSON.parse(node.textContent!).range)).toEqual(componentRanges)
  fireEvent.click(screen.getByRole('button', { name: 'comp 축 역할' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(settings.values.get('signal:box.playing')).toBe(false)
  expect(settings.values.get('signal:box.frameIndex')).toBe(1)
})
