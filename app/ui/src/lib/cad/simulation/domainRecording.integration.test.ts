import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { installCatalogRuntimeSlice } from '../../catalog/runtime'
import { canonicalRecordedDataTree } from './authoring'
import { assertExperimentAuthoringSemantics } from './authoringSemantics'
import type { RecordedDataSpecNode } from './types'
import { resolveRecordedOutputReferences, resolveRecordedResult } from './outputRecording'

describe('Box Grid RecordedData', () => {
  it('keeps numerical tensor schemas separate from generic mesh visualization schemas', () => {
    const fixture = JSON.parse(
      execFileSync(
        'python',
        [
          '-X',
          'utf8',
          '-c',
          `import json,sys
sys.path.insert(0,sys.argv[2])
sys.path.insert(0,sys.argv[1])
from caemble_catalog import open_catalog
from tests.recording_fixtures import MESH_FIELD_SCHEMA
with open_catalog() as catalog:
    data=catalog.runtime_slice(solvers=[('structural-mechanics','5.0.0')],quantity_kinds=['Length','thermodynamics.Temperature'],material_models=[])
    print(json.dumps({'catalog':data,'schema':MESH_FIELD_SCHEMA}))`,
          path.resolve('../slaves/cae'),
          path.resolve('../catalog'),
        ],
        { encoding: 'utf8' },
      ),
    ) as { catalog: CatalogRuntimeSlice; schema: RecordedDataSpecNode }
    installCatalogRuntimeSlice(fixture.catalog)
    const tasks = {
      solid: {
        kind: 'caemble-kernel-task' as const,
        kernel: { name: 'structural-mechanics', version: '5.0.0' },
        config: {
          outputs: [
            { key: 'motion', methodId: 'fea.displacement' },
            { key: 'animation', methodId: 'fea.displacement-history' },
            { key: 'modes', methodId: 'fea.modal-displacement' },
          ],
        },
      },
    }
    expect(() => resolveRecordedResult({ dtype: 'int32' }, tasks, 'manual')).toThrow('manual recording schemas')
    const frozen = resolveRecordedResult({ task: 'solid', output: 'motion' }, tasks, 'anything')
    expect(frozen.visualization.kind).toBe('box-grid')
    expect(frozen.task).toBe('solid')
    expect(frozen.catalogRevision).toBe(fixture.catalog.catalogRevision)
    const reference = resolveRecordedOutputReferences({ task: 'solid', output: 'motion' }, tasks, 'recordedData.motion')
    expect(reference).toHaveProperty('boxGrid.components', ['x', 'y', 'z'])
    expect(reference).not.toHaveProperty('domain')
    const animation = resolveRecordedResult({ task: 'solid', output: 'animation' }, tasks, 'animation')
    expect(animation.schema).toHaveProperty('axes.3.name', 'time')
    expect(animation.visualization.kind).toBe('box-grid')
    expect(canonicalRecordedDataTree({ motion: reference })).toHaveProperty('motion.tensorOrder', 1)
    expect(resolveRecordedOutputReferences({ task: 'solid', output: 'modes' }, tasks, 'modes')).toHaveProperty(
      'boxGrid.frequencyKind',
      'modal',
    )
    expect(() => resolveRecordedOutputReferences({ task: 'absent', output: 'motion' }, tasks, 'record')).toThrow(
      'unknown Task',
    )
    expect(() => resolveRecordedOutputReferences({ task: 'solid', output: 'absent' }, tasks, 'record')).toThrow(
      'unknown output',
    )
    installCatalogRuntimeSlice({ ...fixture.catalog, catalogRevision: 'changed-after-build', solvers: [] })
    expect(frozen.catalogRevision).toBe(fixture.catalog.catalogRevision)
    expect(frozen.visualization.kind).toBe('box-grid')
    const recordedData = canonicalRecordedDataTree({ mesh: fixture.schema })
    const evaluated = {
      scene: { parts: [] },
      taskScenes: {},
      simulationProgram: { tasks: {}, recordedData },
    } as unknown as Parameters<typeof assertExperimentAuthoringSemantics>[1]
    expect(() => assertExperimentAuthoringSemantics(fixture.catalog, evaluated)).not.toThrow()
    expect(() => canonicalRecordedDataTree({ mesh: { unit: { dtype: 'string' } } })).toThrow(
      'must not mix RecordedData descriptor fields',
    )
  })
})
