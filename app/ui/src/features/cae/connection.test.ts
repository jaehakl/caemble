import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateGpStationConnection } from './connection'

const sdk = vi.hoisted(() => ({ clientOptions: vi.fn(), listLaunchers: vi.fn() }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    constructor(options: unknown) {
      sdk.clientOptions(options)
    }

    listLaunchers = sdk.listLaunchers
  },
}))

describe('CAE connection validation', () => {
  beforeEach(() => {
    sdk.clientOptions.mockReset()
    sdk.listLaunchers.mockReset()
  })

  it('validates a token and reports an online cae launcher', async () => {
    sdk.listLaunchers.mockResolvedValue([{ id: 'launcher', status: 'ready', slave_app_ids: ['ai', 'cae'] }])

    await expect(
      validateGpStationConnection({
        api_base_url: ' https://gps.example.test/ ',
        access_token: ' gpsk_test ',
      }),
    ).resolves.toEqual({ hasOnlineCaeLauncher: true })
    expect(sdk.clientOptions).toHaveBeenCalledWith({
      apiBaseUrl: 'https://gps.example.test',
      token: 'gpsk_test',
    })
  })

  it('accepts valid authentication when no online cae launcher exists', async () => {
    sdk.listLaunchers.mockResolvedValue([{ id: 'launcher', status: 'disconnected', slave_app_ids: ['cae'] }])

    await expect(
      validateGpStationConnection({
        api_base_url: 'https://gps.example.test',
        access_token: 'gpsk_test',
      }),
    ).resolves.toEqual({ hasOnlineCaeLauncher: false })
  })

  it('does not accept a token rejected by GPStation', async () => {
    sdk.listLaunchers.mockRejectedValue(new Error('401 Unauthorized'))

    await expect(
      validateGpStationConnection({
        api_base_url: 'https://gps.example.test',
        access_token: 'gpsk_invalid',
      }),
    ).rejects.toThrow('401 Unauthorized')
  })
})
