// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RayPathBundle } from '@/lib/cad'
import type { SavedMeasurement, SavedRecordedData } from '../types'
import { MeasurementDetail } from './MeasurementDetail'
import { MeasurementExplorer } from './MeasurementExplorer'

const api = vi.hoisted(() => ({ listRows: vi.fn() }))

vi.mock('@/api', () => ({
  dbTables: { Measurement: { listRows: api.listRows } },
  getListRequest: (scope = 'visible') => ({
    filter: {},
    limit: 24,
    offset: 0,
    scope,
    search_text: null,
    selected_ids: [],
    sort: ['updated_at', 'desc'],
    text_filter: {},
  }),
}))

const measurement: SavedMeasurement = {
  id: 11,
  experiment_id: 7,
  user_id: 'user-1',
  created_at: '2026-08-20T01:00:00Z',
  updated_at: '2026-08-20T02:00:00Z',
  vars: { width: 12, label: 'sample' },
  material_parameters: {
    schemaVersion: 2,
    experiment: { schemaVersion: 1, materials: { body: { density: 7800 } } },
    tasks: { solve: { schemaVersion: 1, materials: { body: { elasticity: 210 } } } },
  },
  recorded_at: '2026-08-20T03:00:00Z',
}

const measurements = [
  measurement,
  { ...measurement, id: 12, recorded_at: null },
  { ...measurement, id: 13, recorded_at: null },
  { ...measurement, id: 14, recorded_at: null },
]

beforeEach(() => {
  api.listRows.mockReset()
  api.listRows.mockResolvedValue({ items: measurements, total: measurements.length })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Measurement panes', () => {
  it('renders square points and supports single, additive, range, and additive range selection', async () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn(async () => true)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={7} onDelete={onDelete} onSelect={onSelect} selectedId={measurement.id} />
      </QueryClientProvider>,
    )

    const first = await screen.findByRole('button', { name: 'Measurement #11 Recorded' })
    const second = screen.getByRole('button', { name: 'Measurement #12 Prepared' })
    const third = screen.getByRole('button', { name: 'Measurement #13 Prepared' })
    const fourth = screen.getByRole('button', { name: 'Measurement #14 Prepared' })

    await userEvent.click(first)
    expect(onSelect).toHaveBeenCalledWith(measurement)
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Measurement #11')).not.toBeInTheDocument()
    expect(screen.queryByText(JSON.stringify(measurement.vars))).not.toBeInTheDocument()

    fireEvent.click(third, { ctrlKey: true })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(third).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(fourth, { shiftKey: true })
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(second).toHaveAttribute('aria-pressed', 'false')
    expect(third).toHaveAttribute('aria-pressed', 'true')
    expect(fourth).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(first, { ctrlKey: true, shiftKey: true })
    ;[first, second, third, fourth].forEach((button) => expect(button).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('4개 선택')).toBeVisible()
  })

  it('confirms and deletes all selected rows, retaining selection when deletion fails', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={7} onDelete={onDelete} onSelect={vi.fn()} selectedId={measurement.id} />
      </QueryClientProvider>,
    )

    const first = await screen.findByRole('button', { name: 'Measurement #11 Recorded' })
    const second = screen.getByRole('button', { name: 'Measurement #12 Prepared' })
    await userEvent.click(first)
    fireEvent.click(second, { ctrlKey: true })
    await userEvent.click(screen.getByRole('button', { name: '삭제' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Measurement 2개'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Recorded Measurement 1개'))
    expect(onDelete).toHaveBeenNthCalledWith(1, [measurement, measurements[1]])
    expect(screen.getByText('2개 선택')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '삭제' }))
    await waitFor(() => expect(screen.getByText('0개 선택')).toBeVisible())
    expect(onDelete).toHaveBeenNthCalledWith(2, [measurement, measurements[1]])
  })

  it('keeps selections across searches and clears them when the Experiment changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={7} onDelete={vi.fn()} onSelect={vi.fn()} />
      </QueryClientProvider>,
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Measurement #11 Recorded' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Measurement 검색' }), 'width')
    expect(screen.getByText('1개 선택')).toBeVisible()

    await waitFor(() =>
      expect(api.listRows).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { experiment_id: [7, 7] },
          text_filter: { vars: ['width'], material_parameters: ['width'] },
        }),
      ),
    )

    rerender(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={8} onDelete={vi.fn()} onSelect={vi.fn()} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('0개 선택')).toBeVisible())
  })

  it('fills the measured point viewport and preserves the visible range when its capacity changes', async () => {
    let resizeCallback: ResizeObserverCallback | null = null
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
        resizeCallback = callback
        return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() }
      }),
    )
    const available = Array.from({ length: 30 }, (_, index) => ({
      ...measurement,
      id: index + 1,
      recorded_at: null,
    }))
    api.listRows.mockImplementation(async (request: { offset: number; limit: number }) => ({
      items: available.slice(request.offset, request.offset + request.limit),
      total: available.length,
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={7} onDelete={vi.fn()} onSelect={vi.fn()} />
      </QueryClientProvider>,
    )

    expect(resizeCallback).not.toBeNull()
    act(() => {
      resizeCallback!([{ contentRect: { height: 100, width: 200 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    await waitFor(() => expect(api.listRows).toHaveBeenCalledWith(expect.objectContaining({ limit: 8, offset: 0 })))
    expect(await screen.findByRole('button', { name: 'Measurement #8 Prepared' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Measurement #9 Prepared' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '다음' }))
    const ninth = await screen.findByRole('button', { name: 'Measurement #9 Prepared' })
    await userEvent.click(ninth)
    expect(ninth).toHaveAttribute('aria-pressed', 'true')

    act(() => {
      resizeCallback!([{ contentRect: { height: 144, width: 200 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    await waitFor(() => expect(api.listRows).toHaveBeenCalledWith(expect.objectContaining({ limit: 12, offset: 0 })))
    const resizedNinth = await screen.findByRole('button', { name: 'Measurement #9 Prepared' })
    expect(resizedNinth).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Measurement #12 Prepared' }), { shiftKey: true })
    expect(resizedNinth).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Measurement #12 Prepared' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('retains selections across pages and returns from an emptied last page after deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let available = Array.from({ length: 13 }, (_, index) => ({ ...measurement, id: index + 1, recorded_at: null }))
    api.listRows.mockImplementation(async (request: { offset: number; limit: number }) => ({
      items: available.slice(request.offset, request.offset + request.limit),
      total: available.length,
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onDelete = vi.fn(async (rows: readonly SavedMeasurement[]) => {
      const ids = new Set(rows.map((row) => row.id))
      available = available.filter((row) => !ids.has(row.id))
      await client.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
      return true
    })
    render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer experimentId={7} onDelete={onDelete} onSelect={vi.fn()} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(api.listRows).toHaveBeenCalledWith(expect.objectContaining({ limit: 12, offset: 0 })))

    await userEvent.click(await screen.findByRole('button', { name: 'Measurement #1 Prepared' }))
    await userEvent.click(screen.getByRole('button', { name: '다음' }))
    const last = await screen.findByRole('button', { name: 'Measurement #13 Prepared' })
    fireEvent.click(last, { ctrlKey: true })
    expect(screen.getByText('2개 선택')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '삭제' }))
    await screen.findByRole('button', { name: 'Measurement #2 Prepared' })
    expect(screen.getByRole('button', { name: '이전' })).toBeDisabled()
    expect(onDelete).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 13 })]),
    )
  })

  it('shows Measurement and Recorded Data metadata without rendering raw recorded values', () => {
    render(
      <MeasurementDetail
        measurement={measurement}
        recordedRows={[
          {
            id: 31,
            measurement_id: 11,
            name: 'displacement',
            quantity_kind: 'displacement',
            tensor_order: 1,
            dtype: 'float64',
            data_schema: { dtype: 'float64', unit: 'mm' },
            data: { secret: 'raw-payload' },
            file_size: 2048,
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: '#11' })).toBeVisible()
    expect(screen.getByText('Task · solve')).toBeVisible()
    expect(screen.getByText('displacement', { selector: 'p' })).toBeVisible()
    expect(screen.getByText('2,048 B')).toBeVisible()
    expect(screen.queryByText(/raw-payload/)).not.toBeInTheDocument()
  })

  it('counts the five reserved ray-path rows as one system result', () => {
    const members = ['vertices', 'path-offsets', 'segment-power', 'path-wavelength', 'segment-event']
    const rayRows = members.map(
      (member, index) =>
        ({
          id: 40 + index,
          measurement_id: measurement.id,
          name: `@caemble/ray-paths@1/primary/${member}`,
          quantity_kind: null,
          tensor_order: 0,
          dtype: 'uint8',
        }) satisfies SavedRecordedData,
    )
    const rayPathBundle: RayPathBundle = {
      id: 'primary',
      pathCount: 1,
      segmentCount: 2,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      pathOffsets: new Uint32Array([0, 3]),
      segmentPower: new Float32Array([1, 0.5]),
      pathWavelength: new Float32Array([532e-9]),
      segmentEvent: new Uint8Array([2, 5]),
    }

    const { rerender } = render(
      <MeasurementDetail measurement={measurement} rayPathBundles={[rayPathBundle]} recordedRows={rayRows} />,
    )

    const recordedSection = screen.getByRole('heading', { name: 'Recorded Data' }).closest('section')
    expect(recordedSection).toHaveTextContent('Ray paths · 1 paths · 2 segments')
    expect(recordedSection).not.toHaveTextContent('@caemble/ray-paths@1/primary/vertices')
    expect(recordedSection?.querySelector('[data-system-result="ray-paths"]')).not.toBeNull()
    expect(recordedSection?.querySelector('.bg-transparent')).toHaveTextContent('1')

    rerender(
      <MeasurementDetail
        measurement={measurement}
        pendingSave
        rayPathBundles={[rayPathBundle]}
        rayPathsDeclared
        recordedRows={[]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Recorded Data' }).closest('section')).toHaveTextContent(
      'Ray paths · 1 paths · 2 segments',
    )
  })
})
