import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCaeAccessToken, connectCaeAccessToken } from './connection'

const sdk = vi.hoisted(() => ({ listLaunchers: vi.fn() }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = sdk.listLaunchers
  },
}))

describe('CAE connection', () => {
  beforeEach(() => {
    clearCaeAccessToken()
    sdk.listLaunchers.mockReset()
  })

  it('accepts a valid token only when an online cae launcher is present', async () => {
    sdk.listLaunchers.mockResolvedValue([
      { id: 'launcher', status: 'ready', slave_app_ids: ['ai', 'cae'] },
    ])

    await expect(connectCaeAccessToken(' gpsk_test ')).resolves.toBeUndefined()
    expect(sdk.listLaunchers).toHaveBeenCalledOnce()
  })

  it('rejects a token when no connected cae launcher exists', async () => {
    sdk.listLaunchers.mockResolvedValue([
      { id: 'launcher', status: 'disconnected', slave_app_ids: ['cae'] },
    ])

    await expect(connectCaeAccessToken('gpsk_test')).rejects.toThrow('cae launcher가 없습니다')
  })
})
