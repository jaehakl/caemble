import { describe, expect, it } from 'vitest'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import { Material } from '../model/core'
import { serializeEvaluatedDocumentSnapshot } from './snapshot'
import {
  assertEvaluatedDocumentSnapshot,
  assertMeasurementExperimentSnapshot,
  assertPlainSnapshotValue,
} from './snapshotValidation'

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

  it('serializes Canonical Geometry separately from Manifold render scenes without seed', async () => {
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
    const snapshot = await serializeEvaluatedDocumentSnapshot({
      kind: 'experiment',
      scene,
      taskScenes: { main: scene },
      simulationProgram: program,
      sourceHash: 'a'.repeat(64),
      variables: { width: 4 },
      varsSchema: { width: { shape: [], min: 1, max: 10 } },
    })
    expect(snapshot.scene.geometryFormatVersion).toBe(1)
    expect(snapshot.scene.roots.map((root) => root.node.kind)).toEqual(['primitive', 'transform'])
    expect(snapshot.scene.roots[0].material).toEqual(snapshot.scene.roots[1].material)
    expect(snapshot.renderScene.parts[0].geometry.kind).toBe('mesh')
    expect(JSON.stringify(snapshot.scene)).not.toMatch(/"kind":"mesh"|positions|polygonOffsets/u)
    expect(snapshot).not.toHaveProperty('seed')
    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    expect(() => assertEvaluatedDocumentSnapshot({ ...snapshot, variables: { width: 20 } })).toThrow(
      'less than or equal to 10',
    )
    expect(() =>
      assertEvaluatedDocumentSnapshot({
        ...snapshot,
        varsSchema: { width: { min: 1, max: 10 } },
      }),
    ).toThrow('shape is required by CAD API v10')
    expect(() =>
      assertEvaluatedDocumentSnapshot({
        ...snapshot,
        varsSchema: { width: { shape: [2], min: 1, max: 10 } },
        variables: { width: [4] },
      }),
    ).toThrow('must have shape [2]')

    const tooManyTasks = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`task-${index}`, snapshot.scene]),
    )
    expect(() =>
      assertEvaluatedDocumentSnapshot({
        ...snapshot,
        taskScenes: tooManyTasks,
        taskRenderScenes: Object.fromEntries(Object.keys(tooManyTasks).map((name) => [name, snapshot.renderScene])),
      }),
    ).toThrow('at most 128 Task Geometry scenes')

    const largeScene = {
      ...snapshot.scene,
      geometryHash: 'c'.repeat(64),
      roots: [
        {
          id: 'large',
          materialRole: 'body',
          node: { kind: 'primitive', nodeId: 'large', primitive: 'sphere', parameters: { radius: 1, segments: 800 } },
        },
      ],
    }
    expect(() =>
      assertEvaluatedDocumentSnapshot({
        ...snapshot,
        scene: largeScene,
        taskScenes: { main: { ...largeScene, geometryHash: 'd'.repeat(64) } },
      }),
    ).toThrow('aggregate derived-triangle limit')

    const measurementSnapshot = {
      kind: snapshot.kind,
      sourceHash: snapshot.sourceHash,
      variables: snapshot.variables,
      varsSchema: snapshot.varsSchema,
      scene: snapshot.scene,
      taskScenes: snapshot.taskScenes,
      simulationProgram: snapshot.simulationProgram,
    }
    expect(() =>
      assertMeasurementExperimentSnapshot({
        ...measurementSnapshot,
        taskScenes: tooManyTasks,
      }),
    ).toThrow('at most 128 Task Geometry scenes')
    expect(() =>
      assertMeasurementExperimentSnapshot({
        ...measurementSnapshot,
        scene: largeScene,
        taskScenes: { main: { ...largeScene, geometryHash: 'd'.repeat(64) } },
      }),
    ).toThrow('aggregate derived-triangle limit')
  })

  it('accepts a common scene when the Experiment has no Tasks', async () => {
    const scene = evaluateCadScene(h(Box, { id: 'preview' }), {}, 'Experiment')
    const tasklessProgram = { ...program, tasks: {} }
    const snapshot = await serializeEvaluatedDocumentSnapshot({
      kind: 'experiment',
      scene,
      taskScenes: {},
      simulationProgram: tasklessProgram,
      sourceHash: 'b'.repeat(64),
      variables: {},
      varsSchema: {},
    })

    expect(snapshot.scene.roots).toHaveLength(1)
    expect(snapshot.taskScenes).toEqual({})
    expect(snapshot.simulationProgram.tasks).toEqual({})
    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    expect(() => assertEvaluatedDocumentSnapshot({ ...snapshot, simulationProgram: program })).toThrow(
      'do not match its Simulation Program',
    )
    expect(() => assertEvaluatedDocumentSnapshot({ ...snapshot, taskScenes: { main: snapshot.scene } })).toThrow(
      'do not match its Simulation Program',
    )
  })
})
