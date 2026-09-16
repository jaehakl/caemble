// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createCaembleClient } from '@/api/http'
import { objectHash } from '@/api/objectStorage'
import { BOX_GRID_AXES } from '@/contracts/boxGrid'
import { dataCommand } from './data'
import type { CommandContext } from './types'

afterEach(() => vi.unstubAllGlobals())

async function remoteSliceFixture(withMeaning = true) {
  vi.stubGlobal('crypto', webcrypto)
  const bytes = Buffer.alloc(32)
  ;[-4, -2, 3, 8].forEach((value, index) => bytes.writeDoubleLE(value, 8 * index))
  const sha256 = await objectHash(bytes)
  const reference = { kind: 'caemble.object', version: 1, id: 'tensor', encoding: 'base64', byteLength: 32, sha256 }
  const metadataSchema = {
    pressureOffset: { dtype: 'float64', quantityKind: 'Pressure', unit: 'Pa' },
    momentOrigin: { dtype: 'float64', quantityKind: 'Length', unit: 'm', shape: [3] },
    surfaceTargets: { dtype: 'string', shape: [null] },
  }
  const metadata = { pressureOffset: -12, momentOrigin: [0.2, -0.3, 1], surfaceTargets: ['experiment.surface.wall'] }
  const profile = { version: 1, sampling: 'point', components: ['scalar'], channels: ['value'], channelUnits: ['Pa'] }
  const schema = {
    dtype: 'float64',
    quantityKind: 'Pressure',
    unit: 'Pa',
    tensorOrder: 0,
    ...(withMeaning
      ? { axes: BOX_GRID_AXES.map((name) => ({ name })), boxGrid: profile, metadata: metadataSchema }
      : {}),
  }
  const meaning = withMeaning
    ? {
        axes: BOX_GRID_AXES.map((_name, index) => ({
          ticks: index === 0 ? [0.25, 0.75] : index === 3 ? [0, 0.0375] : [0],
        })),
        boxGrid: {
          ...profile,
          origin: [0, 0, 0],
          size: [1, 1, 1],
          rotation: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          lengthUnit: 'm',
          gridShape: [2, 1, 1],
          source: 'experiment',
          rootId: 'probe',
        },
        metadata,
        provenance: {
          task: 'flow',
          solver: { name: 'fixture', version: '1.0.0' },
          stateRevision: 2,
          invocation: 3,
          catalogRevision: 'frozen-revision',
        },
      }
    : {}
  const stored = {
    id: 7,
    name: 'pressure',
    quantityKind: 'Pressure',
    schema,
    downloadRequired: true,
    data: {
      shape: withMeaning ? [2, 1, 1, 2, 1, 1, 1] : [4],
      ...meaning,
      storage: { kind: 'base64', data: reference, byteLength: 32 },
    },
    offset: 1,
    count: 2,
  }
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const address = new URL(String(url))
    if (address.hostname === 'bucket.test') {
      expect(options?.credentials).toBe('omit')
      expect(new Headers(options?.headers).has('authorization')).toBe(false)
      return new Response(bytes)
    }
    if (address.pathname === '/storage/objects/tensor')
      return Response.json({
        reference,
        parts: [{ url: 'https://bucket.test/tensor', headers: {}, sha256, byteLength: 32 }],
      })
    expect(address.pathname).toBe('/data/recorded_data/7/slice')
    expect(address.searchParams.get('offset')).toBe('1')
    expect(address.searchParams.get('count')).toBe('2')
    return Response.json(stored)
  })
  vi.stubGlobal('fetch', fetcher)
  const client = createCaembleClient({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: 'test-key' },
    fetch: fetcher,
  })
  const context: CommandContext = {
    environment: {
      repo: '',
      cae: '',
      python: '',
      envPath: '',
      cli: '',
      worker: '',
      apiUrl: undefined,
      token: undefined,
    },
    args: ['recorded_data', '7'],
    options: { offset: '1', count: '2' },
    signal: new AbortController().signal,
    client: () => client,
  }
  return { stored, context, fetcher }
}

describe('remote CLI tensor slices', () => {
  it.each([false, true])(
    'preserves the frozen schema and optional result meaning after object download, meaning=%s',
    async (withMeaning) => {
      const { stored, context, fetcher } = await remoteSliceFixture(withMeaning)
      const result = await dataCommand('data', 'slice', context)
      expect(result).toMatchObject({
        id: 7,
        name: 'pressure',
        dtype: 'float64',
        quantityKind: 'Pressure',
        dataSchema: stored.schema,
        shape: stored.data.shape,
        offset: 1,
        values: [-2, 3],
        totalValues: 4,
        nextOffset: 3,
      })
      expect(fetcher).toHaveBeenCalledTimes(3)
      if (withMeaning) {
        expect(result).toMatchObject({
          axes: stored.data.axes,
          boxGrid: stored.data.boxGrid,
          metadata: stored.data.metadata,
          resultProvenance: stored.data.provenance,
        })
        expect(result).not.toHaveProperty('provenance')
      } else {
        for (const field of ['axes', 'boxGrid', 'metadata', 'resultProvenance'])
          expect(result).not.toHaveProperty(field)
      }
    },
  )

  it('rejects downloaded values whose declared result metadata is missing', async () => {
    const { stored, context } = await remoteSliceFixture()
    delete stored.data.metadata
    await expect(dataCommand('data', 'slice', context)).rejects.toThrow('metadata')
  })
})
