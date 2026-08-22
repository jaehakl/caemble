// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedMeasurement } from '../types'
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

beforeEach(() => {
  api.listRows.mockReset()
  api.listRows.mockResolvedValue({ items: [measurement], total: 1 })
})

afterEach(cleanup)

describe('Measurement panes', () => {
  it('keeps the explorer mounted while selecting, searching, and duplicating rows', async () => {
    const onSelect = vi.fn()
    const onDuplicate = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MeasurementExplorer
          experimentId={7}
          onDuplicate={onDuplicate}
          onSelect={onSelect}
          selectedId={measurement.id}
        />
      </QueryClientProvider>,
    )

    await userEvent.click(await screen.findByText('Measurement #11'))
    expect(onSelect).toHaveBeenCalledWith(measurement)
    expect(screen.getByRole('region', { name: 'Measurement 목록' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Measurement #11 Recorded/ })).toHaveAttribute('aria-current', 'true')

    await userEvent.click(screen.getByRole('button', { name: 'Measurement #11 복제' }))
    expect(onDuplicate).toHaveBeenCalledWith(measurement)

    await userEvent.type(screen.getByRole('textbox', { name: 'Measurement 검색' }), 'width')
    await waitFor(() =>
      expect(api.listRows).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { experiment_id: [7, 7] },
          text_filter: { vars: ['width'], material_parameters: ['width'] },
        }),
      ),
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
})
