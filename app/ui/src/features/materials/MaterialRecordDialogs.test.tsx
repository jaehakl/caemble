import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { dbTables, type MaterialRecord } from '@/api'
import { MaterialEditDialog } from './MaterialRecordDialogs'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'user:test-user' }))
vi.mock('./queryInvalidation', () => ({ invalidateMaterialQueries: vi.fn().mockResolvedValue(undefined) }))

describe('MaterialEditDialog', () => {
  it('resets when the open record changes and submits the normalized DTO', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const upsertRow = vi.spyOn(dbTables.Material, 'upsertRow').mockResolvedValue([{ id: 2 }])
    const firstMaterial: MaterialRecord = {
      id: 1,
      user_id: 'owner',
      inchi: 'first-inchi',
      description: 'first description',
      color: '#112233',
    }
    const secondMaterial: MaterialRecord = {
      id: 2,
      user_id: 'owner',
      inchi: 'second-inchi',
      description: 'second description',
      color: '#AABBCC',
    }
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MaterialEditDialog material={firstMaterial} onOpenChange={onOpenChange} open />
      </QueryClientProvider>,
    )

    const inchi = screen.getByLabelText('InChI')
    await user.clear(inchi)
    await user.type(inchi, 'unsaved draft')

    rerender(
      <QueryClientProvider client={queryClient}>
        <MaterialEditDialog material={secondMaterial} onOpenChange={onOpenChange} open />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByLabelText('InChI')).toHaveValue('second-inchi'))
    const description = screen.getByLabelText('설명')
    await user.clear(description)
    const color = screen.getByLabelText('Color')
    await user.clear(color)
    await user.type(color, '#abcdef')
    await user.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() =>
      expect(upsertRow).toHaveBeenCalledWith([
        {
          ...secondMaterial,
          inchi: 'second-inchi',
          description: null,
          color: '#abcdef',
        },
      ]),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
