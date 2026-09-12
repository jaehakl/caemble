// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCaembleClient } from '@/api/http'
import type { SaveExperimentRequest } from '@/contracts/api/experiment'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { experimentRecordContracts as webRecordContracts } from '@/features/measurement/recordedData'
import { cadSourceHash } from '@/lib/cad/source/document'
import { prepareCaeMeasurement } from '@/platform/node/build'
import { writeSourceBundle } from '@/platform/node/artifact'
import { experimentCommand } from './experiment'

const definitions = [{ name: 'Mean', description: 'Example', source_code: 'export default () => 1' }]
const catalog = vi.hoisted(() => vi.fn())
vi.mock('@/platform/node/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/node/environment')>()),
  catalogCommand: catalog,
  verifyPython: vi.fn(),
}))

it.each(['create', 'overwrite', 'new_version'] as const)(
  'preserves records and Calculation copy inputs during CLI %s',
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'caemble-experiment-push-'))
    try {
      const sourceBundle = {
        files: {
          'experiment.tsx': `import { Box, experiment } from '@caemble/core'
export default experiment({
  varsSchema: {}, lengthUnit: 'mm', geometry: () => <Box id="probe" size={[2, 3, 4]} />,
  geometryGroup: { probe: ['probe'] },
  recordedData: {
    samples: { task: 'fixture', output: 'samples' },
    secondary: { task: 'fixture', output: 'secondary' },
  },
})`,
          'tasks/fixture.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'fixture', version: '1.0.0' }, config: () => ({ parameters: {}, initializations: [], boundaryConditions: [], exports: [], outputs: [
{ key: 'samples', methodId: 'samples', target: ['experiment.geometry.probe'], parameters: { gridShape: [2, 1, 1] } },
{ key: 'secondary', methodId: 'samples', target: ['experiment.geometry.probe'], parameters: { gridShape: [1, 1, 1] } }
] }) })`,
          'geometry.tsx': 'export {}',
          'material.tsx': 'export {}',
          'simulate.py': 'def simulate(context):\n    return {}\n',
        },
      }
      const dataSchema = {
        dtype: 'float64',
        quantityKind: 'Dimensionless',
        unit: '1',
        axes: ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component'].map((name, index) => ({
          name,
          ...(index < 3 ? {} : { length: 1 }),
        })),
        boxGrid: { version: 1, sampling: 'point', components: ['scalar'], channels: ['value'], channelUnits: ['1'] },
      } as const
      const catalog: CatalogRuntimeSlice = {
        catalogRevision: 'contract-fixture',
        solvers: [
          {
            name: 'fixture',
            version: '1.0.0',
            descriptor: {
              name: 'fixture',
              version: '1.0.0',
              description: '',
              referenceLengthUnit: 'mm',
              parameters: {},
              materials: [],
              inputPorts: {},
              observations: {},
              methods: {
                initializations: [],
                boundaryConditions: [],
                exports: [],
                outputs: [
                  {
                    methodId: 'samples',
                    description: '',
                    minimumOccurrences: 0,
                    maximumOccurrences: 2,
                    target: {
                      source: 'experiment',
                      kind: 'geometry',
                      minimumTargets: 1,
                      maximumTargets: 1,
                      minimumResolved: 1,
                      maximumResolved: 1,
                    },
                    parameters: {
                      gridShape: { description: '', required: true, data: { dtype: 'int32', axes: [{ length: 3 }] } },
                    },
                    artifactType: 'fixture/samples@1',
                    data: { ...dataSchema, visualization: { kind: 'tensor' } },
                  },
                ],
              },
            },
          },
        ],
        quantityKinds: [
          { name: 'Dimensionless', domain: 'general', tensorOrder: 0, opaque: false, applicableUnits: ['1'] },
        ],

        materialModels: [],

        warnings: [],
      }
      const sourceHash = await cadSourceHash({ kind: 'experiment', sourceBundle })
      const built = await prepareCaeMeasurement(
        {
          source_bundle: sourceBundle,
          source_hash: sourceHash,
          catalog,

          mode: 'generate',
          vars_mode: 'nominal',
        },
        path.resolve('src/lib/cad/api'),
      )
      const webRecords = webRecordContracts(built.measurement.experiment.simulationProgram.recordedData)
      expect(webRecords).toEqual([
        {
          name: 'samples',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          dtype: 'float64',
          data_schema: dataSchema,
        },
        {
          name: 'secondary',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          dtype: 'float64',
          data_schema: dataSchema,
        },
      ])
      const source = path.join(root, 'source')
      const artifact = path.join(root, 'artifact')
      await writeSourceBundle(source, sourceBundle)
      await writeFile(
        path.join(source, 'caemble.json'),
        JSON.stringify({
          ...(mode === 'create' ? {} : { id: 11 }),
          calculations: definitions,
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
          version: 2,
          builder_version: '2',
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
          // The server locks this exact contract once a Measurement exists.
          expect(request.records).toEqual(webRecords)
          return Response.json({
            id: 11,
            action: mode,
            namespace: 'fixture',
            repository: 'tests',
            key: 'same-source',
            version: '0.1.0',
            coordinate: '@fixture/tests/same-source@0.1.0',
            bundleHash: sourceHash,
            sourceLocked: true,
            result_contracts: {},
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
        options: { artifact, ...(mode === 'new_version' ? { 'new-version': 'patch' } : {}) },
        signal: new AbortController().signal,
        client: () => client,
      })
      expect(request).toMatchObject({ mode, sourceBundle, bundleHash: sourceHash })
      if (mode === 'create') expect(request).toHaveProperty('calculations', definitions)
      else {
        expect(request).toHaveProperty('experimentId', 11)
        expect(request).not.toHaveProperty('calculations')
      }
      expect(result).toMatchObject({ id: 11, action: mode, sourceLocked: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

it('initializes an example with its Calculation definitions for the first push', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caemble-example-calculations-'))
  try {
    catalog.mockResolvedValue({
      key: 'example',
      calculations: definitions,
      sourceBundle: { files: { 'experiment.tsx': 'export default null' } },
    })
    await experimentCommand('init', {
      environment: { repo: root, cae: root, python: '', envPath: '', cli: '', worker: '', apiUrl: '', token: '' },
      args: [root],
      options: { example: 'example' },
      signal: new AbortController().signal,
      client: () => {
        throw new Error('init must not contact the API')
      },
    })
    const metadata = JSON.parse(await readFile(path.join(root, 'caemble.json'), 'utf8'))
    expect(metadata).toMatchObject({ kind: 'experiment', calculations: definitions })
    expect(metadata).not.toHaveProperty('id')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
