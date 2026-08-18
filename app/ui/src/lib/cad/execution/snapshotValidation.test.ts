import { describe, expect, it } from 'vitest'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import { Material } from '../model/core'
import { serializeEvaluatedDocumentSnapshot } from './snapshot'
import { assertEvaluatedDocumentSnapshot, assertPlainSnapshotValue } from './snapshotValidation'

function Box() {
  return h('box', { size: [1, 1, 1] })
}
const program = {
  formatVersion: 5 as const,
  simulationApiVersion: 3 as const,
  pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
  tasks: { main: { kernel: { name: 'test', version: '1' }, config: {} } },
  recordedData: {},
}

describe('Experiment snapshot validation', () => {
  it('accepts shared plain values and rejects cycles', () => {
    const shared = Object.freeze({ color: '#2563eb' })
    const value = { first: shared, second: shared }
    expect(() => assertPlainSnapshotValue(value)).not.toThrow()
    const direct: Record<string, unknown> = {}
    direct.self = direct
    expect(() => assertPlainSnapshotValue(direct)).toThrow('cyclic value')
  })

  it('serializes common and Task scenes without seed', () => {
    const material = new Material('Shared', { color: '#2563eb' })
    const scene = evaluateCadScene(
      h(
        Fragment,
        null,
        h(Box, { id: 'first', materials: { body: material } }),
        h(Box, { id: 'second', position: [2, 0, 0], materials: { body: material } }),
      ),
      {},
      'Experiment',
    )
    const snapshot = serializeEvaluatedDocumentSnapshot({
      kind: 'experiment',
      scene,
      taskScenes: { main: scene },
      simulationProgram: program,
      sourceHash: 'a'.repeat(64),
      variables: { width: 4 },
      varsSchema: { width: { min: 1, max: 10 } },
    })
    expect(snapshot.scene.parts[0].material).toBe(snapshot.scene.parts[1].material)
    expect(snapshot).not.toHaveProperty('seed')
    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    expect(() => assertEvaluatedDocumentSnapshot({ ...snapshot, variables: { width: 20 } })).toThrow(
      'less than or equal to 10',
    )
  })
})
