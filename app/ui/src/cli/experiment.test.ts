// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createCaembleClient } from '@/api/http'
import type { SaveExperimentRequest } from '@/contracts/api/experiment'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { experimentRecordContracts as webRecordContracts } from '@/features/measurement/recordedData'
import { cadSourceHash } from '@/lib/cad/source/document'
import { prepareCaeMeasurement } from '@/platform/node/build'
import { writeSourceBundle } from '@/platform/node/artifact'
import { experimentCommand } from './experiment'

it('preserves the web record contract when CLI pushes the same built Experiment source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caemble-experiment-push-'))
  try {
    const sourceBundle = {
      files: {
        'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({
  varsSchema: {}, lengthUnit: 'mm', geometry: () => [],
  recordedData: {
    samples: { dtype: 'int32', axes: [{ name: 'samples' }] },
    group: { label: { dtype: 'string' } },
  },
})`,
        'geometry.tsx': 'export {}',
        'material.tsx': 'export {}',
        'simulate.py': 'def simulate(context):\n    return {}\n',
      },
    }
    const catalog: CatalogRuntimeSlice = {
      catalogRevision: 'contract-fixture',
      solvers: [],
      quantityKinds: [],
      materialParameters: [],
      materialModels: [],
      materialGlobalQualifiers: [],
      warnings: [],
    }
    const sourceHash = await cadSourceHash({ kind: 'experiment', sourceBundle })
    const built = await prepareCaeMeasurement(
      {
        source_bundle: sourceBundle,
        source_hash: sourceHash,
        catalog,
        materials: { names: [], materials: [], parameters: [], qualifiers: [] },
        mode: 'generate',
        vars_mode: 'nominal',
      },
      path.resolve('src/lib/cad/api'),
    )
    const webRecords = webRecordContracts(built.measurement.experiment.simulationProgram.recordedData)
    expect(webRecords).toEqual([
      {
        name: 'samples',
        quantity_kind: null,
        tensor_order: 0,
        dtype: 'int32',
        data_schema: { dtype: 'int32', axes: [{ name: 'samples' }] },
      },
      {
        name: 'group.label',
        quantity_kind: null,
        tensor_order: 0,
        dtype: 'string',
        data_schema: { dtype: 'string' },
      },
    ])
    const source = path.join(root, 'source')
    const artifact = path.join(root, 'artifact')
    await writeSourceBundle(source, sourceBundle)
    await writeFile(
      path.join(source, 'caemble.json'),
      JSON.stringify({
        id: 11,
        namespace: 'fixture',
        repository: 'tests',
        key: 'same-source',
        name: '한글',
        baseBundleHash: sourceHash,
      }),
      'utf8',
    )
    await mkdir(path.join(artifact, 'items'), { recursive: true })
    const input = Buffer.from(JSON.stringify({ measurement: built.measurement, presentation: built.presentation }))
    await writeFile(path.join(artifact, 'items/1.json'), input)
    await writeFile(
      path.join(artifact, 'manifest.json'),
      JSON.stringify({
        kind: 'caemble.build',
        version: 1,
        builder_version: '1',
        source_hash: sourceHash,
        catalog_revision: catalog.catalogRevision,
        mode: 'generate',
        source_bundle: sourceBundle,
        items: [
          {
            index: 1,
            file: 'items/1.json',
            input_hash: createHash('sha256').update(input).digest('hex'),
            byte_length: input.length,
          },
        ],
      }),
      'utf8',
    )
    let request: SaveExperimentRequest | undefined
    const client = createCaembleClient({
      baseUrl: 'https://caemble.test/api',
      auth: { kind: 'bearer', token: 'fixture' },
      fetch: async (url, init) => {
        expect(url).toBe('https://caemble.test/api/experiment/save')
        request = JSON.parse(String(init?.body)) as SaveExperimentRequest
        // The server locks this exact contract once derived data exists.
        expect(request.records).toEqual(webRecords)
        return Response.json({
          id: 11,
          action: 'overwrite',
          namespace: 'fixture',
          repository: 'tests',
          key: 'same-source',
          version: '0.1.0',
          coordinate: '@fixture/tests/same-source@0.1.0',
          bundleHash: sourceHash,
          sourceLocked: true,
          derivedCounts: { measurements: 1, recordedData: 2, calculations: 0 },
        })
      },
    })
    const result = await experimentCommand('push', {
      environment: {
        repo: root,
        cae: root,
        python: '',
        envPath: '',
        cli: '',
        worker: '',
        apiUrl: client.baseUrl,
        token: 'fixture',
      },
      args: [source],
      options: { artifact },
      signal: new AbortController().signal,
      client: () => client,
    })
    expect(request).toMatchObject({ mode: 'overwrite', experimentId: 11, sourceBundle, bundleHash: sourceHash })
    expect(result).toMatchObject({ id: 11, action: 'overwrite', sourceLocked: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
