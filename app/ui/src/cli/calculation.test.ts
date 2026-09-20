// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculationCommand } from './calculation'
import type { CommandContext } from './types'

const { listRows, deleteRows } = vi.hoisted(() => ({ listRows: vi.fn(), deleteRows: vi.fn() }))
vi.mock('@/api/api', () => ({
  getListRequest: () => ({}),
  createDbTables: () => ({ Calculation: { listRows, deleteRows } }),
}))

function context(args: string[], experiment: string | undefined = '51') {
  return {
    args,
    options: { experiment },
    signal: new AbortController().signal,
    client: vi.fn(),
    environment: {},
  } as unknown as CommandContext
}

beforeEach(() => {
  vi.resetAllMocks()
  listRows.mockResolvedValue({
    items: [
      { id: 125, experiment_id: 51 },
      { id: 126, experiment_id: 51 },
    ],
  })
})

describe('calculation delete', () => {
  it('checks membership and deletes explicit IDs once', async () => {
    await expect(calculationCommand('calculation', 'delete', context(['125', '126', '125']))).resolves.toEqual({
      experiment_id: 51,
      deleted_ids: [125, 126],
    })
    expect(listRows.mock.calls[0][0]).toMatchObject({ experiment_id: 51, selected_ids: [125, 126] })
    expect(deleteRows).toHaveBeenCalledExactlyOnceWith([125, 126])
  })

  it.each([[], ['0'], ['-1'], ['1.2'], ['NaN'], ['9007199254740992']])('rejects invalid IDs %j', async (...args) => {
    await expect(calculationCommand('calculation', 'delete', context(args))).rejects.toThrow()
    expect(deleteRows).not.toHaveBeenCalled()
  })

  it('requires an experiment', async () => {
    await expect(calculationCommand('calculation', 'delete', context(['125'], ''))).rejects.toThrow()
    expect(listRows).not.toHaveBeenCalled()
  })

  it.each([{ items: [] }, { items: [{ id: 125, experiment_id: 52 }] }])(
    'rejects missing or foreign rows',
    async (response) => {
      listRows.mockResolvedValue(response)
      await expect(calculationCommand('calculation', 'delete', context(['125']))).rejects.toThrow('was not found')
      expect(deleteRows).not.toHaveBeenCalled()
    },
  )

  it('propagates API failure', async () => {
    deleteRows.mockRejectedValue(new Error('server failure'))
    await expect(calculationCommand('calculation', 'delete', context(['125']))).rejects.toThrow('server failure')
  })

  it('does not delete when a later membership page fails', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => index + 1)
    listRows.mockResolvedValueOnce({ items: ids.slice(0, 50).map((id) => ({ id, experiment_id: 51 })) })
    listRows.mockResolvedValueOnce({ items: [] })
    await expect(calculationCommand('calculation', 'delete', context(ids.map(String)))).rejects.toThrow()
    expect(deleteRows).not.toHaveBeenCalled()
  })
})
