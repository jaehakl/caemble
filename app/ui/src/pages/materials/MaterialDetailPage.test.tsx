// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialDetail } from './MaterialDetailPage'
import { getMaterialModel, getMaterialProperty, getQuantityValueConfig, materialFloatDTypes } from './material-value'

const api = vi.hoisted(() => ({
  deleteMaterial: vi.fn(),
  deleteName: vi.fn(),
  deleteParameter: vi.fn(),
  deleteQualifier: vi.fn(),
  listMaterials: vi.fn(),
  listNames: vi.fn(),
  listParameters: vi.fn(),
  listQualifiers: vi.fn(),
  upsertMaterial: vi.fn(),
  upsertName: vi.fn(),
  upsertParameter: vi.fn(),
  upsertQualifier: vi.fn(),
}))
const auth = vi.hoisted(() => ({ roles: ['user'] as string[] }))

vi.mock('@/api', () => ({
  dbTables: {
    Material: { deleteRows: api.deleteMaterial, listRows: api.listMaterials, upsertRow: api.upsertMaterial },
    MaterialName: { deleteRows: api.deleteName, listRows: api.listNames, upsertRow: api.upsertName },
    MaterialParameter: {
      deleteRows: api.deleteParameter,
      listRows: api.listParameters,
      upsertRow: api.upsertParameter,
    },
    MaterialParameterQualifier: {
      deleteRows: api.deleteQualifier,
      listRows: api.listQualifiers,
      upsertRow: api.upsertQualifier,
    },
  },
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

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-id', email: 'user@example.com', is_active: true, roles: auth.roles },
  }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MaterialDetail materialId={1} onBack={vi.fn()} />
    </QueryClientProvider>,
  )
}

async function chooseMaterialCatalogEntry(key: string, currentKey?: string) {
  const parameterDialog = screen.getByRole('dialog')
  const catalogButton = currentKey
    ? within(parameterDialog).getByText(currentKey).closest('button')!
    : within(parameterDialog).getByRole('button', { name: 'Material parameter를 선택하세요' })
  await userEvent.click(catalogButton)
  const picker = screen.getAllByRole('dialog').find((dialog) => within(dialog).queryByText('Material parameter 탐색'))!
  await userEvent.type(within(picker).getByLabelText('Material parameter 카탈로그 검색'), key)
  await userEvent.click(within(picker).getByText(key).closest('button')!)
}

beforeEach(() => {
  auth.roles = ['user']
  api.listMaterials.mockResolvedValue({
    items: [{ id: 1, inchi: 'InChI=1S/Cu', color: '#d97706', user_id: null }],
    total: 1,
  })
  api.listNames.mockResolvedValue({ items: [{ id: 10, material_id: 1, name: 'Copper', user_id: null }], total: 1 })
  api.listParameters.mockResolvedValue({ items: [], total: 0 })
  api.listQualifiers.mockResolvedValue({ items: [], total: 0 })
  api.upsertParameter.mockResolvedValue([{ id: 20 }])
  api.upsertMaterial.mockResolvedValue([{ id: 1 }])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MaterialDetailPage permissions and solver guidance', () => {
  it('syncs direct color input with the palette and saves a palette selection', async () => {
    auth.roles = ['admin']
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '편집' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByLabelText('Color')
    const palette = within(dialog).getByLabelText('Color palette')
    expect(palette).toHaveValue('#d97706')
    await userEvent.clear(input)
    await userEvent.type(input, '#A1B2C3')
    expect(palette).toHaveValue('#a1b2c3')
    await userEvent.clear(input)
    await userEvent.type(input, 'blue')
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeDisabled()
    fireEvent.change(palette, { target: { value: '#336699' } })
    expect(input).toHaveValue('#336699')
    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() =>
      expect(api.upsertMaterial).toHaveBeenCalledWith([expect.objectContaining({ color: '#336699', id: 1 })]),
    )
  })

  it('clears an existing color back to null and resets the picker display to white', async () => {
    auth.roles = ['admin']
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '편집' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '색상 지우기' }))
    expect(within(dialog).getByLabelText('Color')).toHaveValue('')
    expect(within(dialog).getByLabelText('Color palette')).toHaveValue('#ffffff')
    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() =>
      expect(api.upsertMaterial).toHaveBeenCalledWith([expect.objectContaining({ color: null, id: 1 })]),
    )
  })

  it('keeps a public Material read-only while allowing a user to add a private parameter', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    expect(screen.getByText('#d97706')).toBeInTheDocument()
    expect(screen.getByLabelText('색상 #d97706')).toHaveStyle({ backgroundColor: '#d97706' })
    expect(screen.queryByRole('button', { name: '편집' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '이름 추가' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Parameter 추가' })).toBeEnabled()

    expect(screen.queryByRole('heading', { name: '사용 가능한 Solver' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parameter 추가' }))
    await chooseMaterialCatalogEntry('electrical.conductivity')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('electrical.conductivity')).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Dtype' })).toHaveTextContent('float32')
    expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveTextContent(/^dS\.m-1$/)
    const conductivity = [
      [59_600_000, 0, 0],
      [0, 59_600_000, 0],
      [0, 0, 59_600_000],
    ]
    await userEvent.type(within(dialog).getByLabelText('Value Diagonal'), '59600000')
    expect(within(dialog).getByLabelText('Value Off diagonal')).toHaveValue('')
    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() =>
      expect(api.upsertParameter).toHaveBeenCalledWith([
        expect.objectContaining({
          material_id: 1,
          name: 'electrical.conductivity',
          user_id: 'user-id',
          value: { dtype: 'float32', value: conductivity, unit: 'dS.m-1' },
        }),
      ]),
    )
  })

  it('edits a sampled relation with catalog units and direct sample inputs', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parameter 추가' }))
    await chooseMaterialCatalogEntry('model.sorption.isotherm')

    const dialog = screen.getByRole('dialog')
    const definition = getMaterialModel('model.sorption.isotherm')!
    const inputUnit = getQuantityValueConfig(definition.input.quantity_kind).units[0]
    const outputUnit = getQuantityValueConfig(definition.output.quantity_kind).units[0]
    expect(within(dialog).getByRole('combobox', { name: 'Input unit' })).toHaveTextContent(inputUnit)
    expect(within(dialog).getByRole('combobox', { name: 'Output unit' })).toHaveTextContent(outputUnit)
    const minimumSampleDeleteButtons = within(dialog).getAllByRole('button', { name: /샘플 \d+ 삭제/ })
    expect(minimumSampleDeleteButtons).toHaveLength(2)
    minimumSampleDeleteButtons.forEach((button) => expect(button).toBeDisabled())

    await userEvent.click(within(dialog).getByRole('button', { name: '샘플 추가' }))
    expect(within(dialog).getAllByRole('button', { name: /샘플 \d+ 삭제/ })).toHaveLength(3)
    await userEvent.click(within(dialog).getByRole('button', { name: '샘플 3 삭제' }))

    await userEvent.type(within(dialog).getByLabelText('샘플 1 Input value'), '20')
    await userEvent.type(within(dialog).getByLabelText('샘플 1 Output value'), '0.1')
    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() =>
      expect(api.upsertParameter).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'model.sorption.isotherm',
          value: {
            kind: 'sampled_relation',
            input: { unit: inputUnit, values: [20, 0] },
            output: { unit: outputUnit, values: [0.1, 0] },
          },
        }),
      ]),
    )
  })

  it('warns about a legacy value and requires re-entry through the structured form', async () => {
    api.listParameters.mockResolvedValue({
      items: [{ id: 20, material_id: 1, name: 'general.mass_density', value: 2700, user_id: 'user-id' }],
      total: 1,
    })
    renderPage()
    expect(await screen.findByText('구조화 형식과 호환되지 않는 기존 값입니다.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'general.mass_density 편집' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('기존 값이 현재 구조화 형식과 호환되지 않습니다.')
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeEnabled()
    await userEvent.type(within(dialog).getByLabelText('Value'), '2700')
    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))

    const definition = getMaterialProperty('general.mass_density')!
    const defaultUnit = getQuantityValueConfig(definition.quantity_kind).units[0]
    await waitFor(() =>
      expect(api.upsertParameter).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 20,
          name: 'general.mass_density',
          value: { dtype: 'float32', value: 2700, unit: defaultUnit },
        }),
      ]),
    )
  })

  it('offers only float dtypes and resets value state when the catalog key changes', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parameter 추가' }))
    await chooseMaterialCatalogEntry('general.mass_density')

    let dialog = screen.getByRole('dialog')
    expect(materialFloatDTypes).toEqual(['float16', 'float32', 'float64'])
    expect(within(dialog).getByRole('combobox', { name: 'Dtype' })).toHaveTextContent('float32')
    await userEvent.type(within(dialog).getByLabelText('Value'), '2700')

    await chooseMaterialCatalogEntry('electrical.conductivity', 'general.mass_density')
    dialog = screen.getByRole('dialog')
    const conductivity = getMaterialProperty('electrical.conductivity')!
    const defaultUnit = getQuantityValueConfig(conductivity.quantity_kind).units[0]
    expect(within(dialog).getByRole('combobox', { name: 'Dtype' })).toHaveTextContent('float32')
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveTextContent(defaultUnit))
    const inputs = within(dialog).getAllByRole('textbox', { name: /^Value \[/ })
    expect(inputs).toHaveLength(9)
    inputs.forEach((input) => expect(input).toHaveValue(''))
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeEnabled()
    expect(within(dialog).getByText('빈 값은 0으로 저장됩니다.')).toBeInTheDocument()

    await chooseMaterialCatalogEntry('mechanical.elastic_stiffness_tensor', 'electrical.conductivity')
    dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Value Diagonal')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Value Off diagonal')).not.toBeInTheDocument()
  })

  it('applies and overwrites 3x3 diagonal shortcuts while preserving individual editing', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parameter 추가' }))
    await chooseMaterialCatalogEntry('electrical.conductivity')

    const dialog = screen.getByRole('dialog')
    const diagonal = within(dialog).getByLabelText('Value Diagonal')
    const offDiagonal = within(dialog).getByLabelText('Value Off diagonal')
    await userEvent.type(diagonal, '4')
    await userEvent.type(offDiagonal, '1')
    expect(within(dialog).getByLabelText('Value [0] [0]')).toHaveValue('4')
    expect(within(dialog).getByLabelText('Value [2] [2]')).toHaveValue('4')
    expect(within(dialog).getByLabelText('Value [0] [2]')).toHaveValue('1')
    expect(within(dialog).getByLabelText('Value [2] [1]')).toHaveValue('1')

    const individuallyEdited = within(dialog).getByLabelText('Value [0] [1]')
    await userEvent.clear(individuallyEdited)
    await userEvent.type(individuallyEdited, '7')
    expect(offDiagonal).toHaveValue('')
    expect(individuallyEdited).toHaveValue('7')
    expect(within(dialog).getByLabelText('Value [1] [0]')).toHaveValue('1')

    await userEvent.type(offDiagonal, '2')
    expect(individuallyEdited).toHaveValue('2')
    expect(within(dialog).getByLabelText('Value [1] [2]')).toHaveValue('2')
    await userEvent.clear(diagonal)
    expect(diagonal).toHaveValue('0')
    expect(within(dialog).getByLabelText('Value [0] [0]')).toHaveValue('0')
    expect(within(dialog).getByLabelText('Value [1] [1]')).toHaveValue('0')
    expect(within(dialog).getByLabelText('Value [2] [2]')).toHaveValue('0')

    await userEvent.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() =>
      expect(api.upsertParameter).toHaveBeenCalledWith([
        expect.objectContaining({
          value: {
            dtype: 'float32',
            unit: 'dS.m-1',
            value: [
              [0, 2, 2],
              [2, 0, 2],
              [2, 2, 0],
            ],
          },
        }),
      ]),
    )
  })

  it('restores matrix shortcuts only when every value in the group is equal', async () => {
    api.listParameters.mockResolvedValue({
      items: [
        {
          id: 20,
          material_id: 1,
          name: 'electrical.conductivity',
          user_id: 'user-id',
          value: {
            dtype: 'float32',
            unit: 'dS.m-1',
            value: [
              [4, 1, 1],
              [1, 4, 1],
              [1, 1, 4],
            ],
          },
        },
      ],
      total: 1,
    })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'electrical.conductivity 편집' }))
    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Value Diagonal')).toHaveValue('4')
    expect(within(dialog).getByLabelText('Value Off diagonal')).toHaveValue('1')

    cleanup()
    api.listParameters.mockResolvedValue({
      items: [
        {
          id: 21,
          material_id: 1,
          name: 'electrical.conductivity',
          user_id: 'user-id',
          value: {
            dtype: 'float32',
            unit: 'dS.m-1',
            value: [
              [4, 2, 1],
              [1, 4, 1],
              [1, 1, 4],
            ],
          },
        },
      ],
      total: 1,
    })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'electrical.conductivity 편집' }))
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Value Diagonal')).toHaveValue('4')
    expect(within(dialog).getByLabelText('Value Off diagonal')).toHaveValue('')
    expect(within(dialog).getByLabelText('Value [0] [1]')).toHaveValue('2')
    expect(within(dialog).getByLabelText('Value [0] [2]')).toHaveValue('1')
  })

  it('stores blank scalar values as zero and disables saving for non-numeric values', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Parameter 추가' }))
    await chooseMaterialCatalogEntry('general.mass_density')

    const dialog = screen.getByRole('dialog')
    const value = within(dialog).getByLabelText('Value')
    const save = within(dialog).getByRole('button', { name: '저장' })
    expect(save).toBeEnabled()
    await userEvent.type(value, 'not-a-number')
    expect(save).toBeDisabled()
    await userEvent.clear(value)
    expect(save).toBeEnabled()
    await userEvent.click(save)

    const definition = getMaterialProperty('general.mass_density')!
    await waitFor(() =>
      expect(api.upsertParameter).toHaveBeenCalledWith([
        expect.objectContaining({
          value: {
            dtype: 'float32',
            unit: getQuantityValueConfig(definition.quantity_kind).units[0],
            value: 0,
          },
        }),
      ]),
    )
  })
})
