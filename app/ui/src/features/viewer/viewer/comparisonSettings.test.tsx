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

function fixture(name: string, scale: number, times = 3) {
  const shape = [2, 2, 1, times, 2, 1, 2]
  const axisNames = ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component']
  const grid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components: ['a', 'b'],
    channels: ['value'],
    channelUnits: ['m'],
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
  const rules: RecordedDataRule[] = [
    {
      label: name,
      methodId: 'stored',
      parameters: {},
      target: [],
      result: {
        dtype: 'float64',
        quantityKind: 'Length',
        unit: 'm',
        boxGrid: grid,
        axes: axisNames.map((name) => ({ name })),
      },
    },
  ]
  const data: RecordedData = {
    [name]: {
      shape,
      axes: shape.map((length, axis) => ({
        ticks: Array.from({ length }, (_, index) => (axis < 3 ? (index + 0.5) / length : index)),
      })),
      boxGrid: grid,
      storage: {
        kind: 'inline',
        value: varsTensorFromFlat(
          Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, index) => scale * (index + 1)),
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
}: {
  settings: ComparisonSettings
  name?: string
  scale?: number
  times?: number
  visible?: boolean
  suspended?: boolean
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const input = useMemo(() => [fixture(name, scale, times), fixture(name, scale * 10, times)], [name, scale, times])
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
              canOverlayGeometry
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

it('shares one toolbar, retains settings through replacement and remount, and computes independent automatic ranges', async () => {
  const settings = createComparisonSettings()
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
  const settings = createComparisonSettings()
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
  const settings = createComparisonSettings()
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
      settings: createComparisonSettings(),
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
