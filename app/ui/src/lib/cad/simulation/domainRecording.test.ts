import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { installCatalogRuntimeSlice } from '../../catalog/runtime'
import { canonicalRecordedDataTree } from './authoring'
import { assertExperimentAuthoringSemantics } from './authoringSemantics'
import type { RecordedDataSpecNode } from './types'

describe('domain preserving RecordedData', () => {
  it('accepts the worker mesh field declaration with the real Catalog', () => {
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
    data=catalog.runtime_slice(solvers=[],quantity_kinds=['Length','thermodynamics.Temperature'],material_parameters=[])
    print(json.dumps({'catalog':data,'schema':MESH_FIELD_SCHEMA}))`,
          path.resolve('../slaves/cae'),
          path.resolve('../catalog'),
        ],
        { encoding: 'utf8' },
      ),
    ) as { catalog: CatalogRuntimeSlice; schema: RecordedDataSpecNode }
    installCatalogRuntimeSlice(fixture.catalog)
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
