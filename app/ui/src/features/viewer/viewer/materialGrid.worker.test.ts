import { booleans, primitives, transforms } from '@jscad/modeling'
import { afterEach, describe, expect, it, vi } from 'vitest'
import materialGridSource from './materialGrid.ts?raw'

describe('Material Grid worker module', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('keeps its runtime dependency graph on worker-safe geometry modules', () => {
    expect(materialGridSource).toContain("from '@/lib/cad/geometry/solid'")
    expect(materialGridSource).toContain("from '@/lib/cad/evaluation/types'")
    expect(materialGridSource).not.toMatch(/from ['"]@\/lib\/cad['"]/)
    expect(materialGridSource).not.toContain('monaco')
  })

  it('installs its handler and returns a successful grid for the default conductor', async () => {
    const postMessage = vi.fn()
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    }
    vi.stubGlobal('self', workerScope)
    await import('./materialGrid.worker')

    const geometry = booleans.subtract(
      primitives.cuboid({ size: [100, 12, 10] }),
      transforms.translate([0, 4, 2.5], primitives.cuboid({ size: [30, 5, 6] })),
    )
    workerScope.onmessage?.({
      data: {
        parts: [
          {
            id: 'conductor',
            geometry,
            material: { name: 'Copper', variables: { color: '#d97706' } },
            surfaces: [],
          },
        ],
        requestId: 'grid-1',
        requestedSpacing: 1,
      },
    } as MessageEvent)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [response, transfer] = postMessage.mock.calls[0]
    expect(response).toMatchObject({
      requestId: 'grid-1',
      result: { requestedSpacing: 1 },
      type: 'success',
    })
    expect(response.result.visiblePointCount).toBeGreaterThan(0)
    expect(transfer).toEqual([response.result.positions.buffer, response.result.colors.buffer])
  })
})
