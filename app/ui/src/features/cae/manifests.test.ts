// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCaeSolverManifests } from './manifests'

const sdk = vi.hoisted(() => ({ clientOptions: vi.fn(), runJob: vi.fn() }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    constructor(options: unknown) {
      sdk.clientOptions(options)
    }

    runJob = sdk.runJob
  },
}))

const connection = {
  api_base_url: 'https://gps.example.test',
  access_token: 'gpsk_test',
}

function manifest(name: string) {
  return {
    schemaVersion: 1,
    implementation: `app.solvers.${name}.solver:run`,
    descriptor: {
      name,
      version: '1.0.0',
      description: `${name} solver`,
      referenceLengthUnit: 'm',
      minimumOutputs: 0,
      parameters: {},
      materials: [],
      inputPorts: {},
      observations: {},
      methods: {
        initializations: [],
        boundaryConditions: [],
        outputs: [],
      },
    },
  }
}

function response(manifests: unknown[], file = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifests))
  return {
    payload: {
      formatVersion: 1,
      count: manifests.length,
      attachmentId: 'solver-manifests',
    },
    files: [
      {
        id: 'solver-manifests',
        name: 'solver-manifests.json',
        mimeType: 'application/json; charset=utf-8',
        size: bytes.byteLength,
        blob: { arrayBuffer: async () => bytes.slice().buffer } as Blob,
        ...file,
      },
    ],
  }
}

describe('CAE solver manifest client', () => {
  beforeEach(() => {
    sdk.clientOptions.mockReset()
    sdk.runJob.mockReset()
  })

  it('requests the read-only handler and returns sorted full manifests', async () => {
    sdk.runJob.mockResolvedValue(response([manifest('alpha'), manifest('beta')]))

    const result = await fetchCaeSolverManifests(connection)

    expect(sdk.clientOptions).toHaveBeenCalledWith({
      apiBaseUrl: connection.api_base_url,
      token: connection.access_token,
    })
    expect(sdk.runJob).toHaveBeenCalledWith('cae.solvers.manifests', {}, { slaveAppId: 'cae', timeoutMs: 60_000 })
    expect(result.map(({ descriptor }) => descriptor.name)).toEqual(['alpha', 'beta'])
    expect(result[0].implementation).toBe('app.solvers.alpha.solver:run')
  })

  it('distinguishes malformed attachments from invalid manifest content', async () => {
    sdk.runJob.mockResolvedValueOnce(response([manifest('alpha')], { id: 'wrong' }))
    await expect(fetchCaeSolverManifests(connection)).rejects.toEqual(
      expect.objectContaining({ code: 'protocol_error' }),
    )

    sdk.runJob.mockResolvedValueOnce(response([manifest('beta'), manifest('alpha')]))
    await expect(fetchCaeSolverManifests(connection)).rejects.toEqual(
      expect.objectContaining({ code: 'invalid_manifest' }),
    )
  })
})
