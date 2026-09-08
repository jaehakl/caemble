// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDataTensorAccessor } from '@/lib/cad/model/dataTensor'
import { cadSourceHash } from '@/lib/cad/source/document'
import type { DataSchema, RecordedDataTensor } from '@/lib/cad/model/descriptor'
import { dataCommand } from '@/cli/data'
import { createLocalCalculationInput, exportLocalResult, inspectLocalResult, sliceLocalResult } from './localResult'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'caemble-local-result-'))
  directories.push(root)
  const artifact = path.join(root, 'build')
  const result = path.join(root, '한글 결과')
  await mkdir(path.join(artifact, 'items'), { recursive: true })
  await mkdir(path.join(result, 'records'), { recursive: true })
  const schema = {
    signal: { dtype: 'float64', tensorOrder: 0, quantityKind: 'Length', unit: 'm', axes: [{ name: 'samples' }] },
    label: { dtype: 'string', tensorOrder: 0 },
    vector: {
      dtype: 'float32',
      tensorOrder: 1,
      quantityKind: 'Displacement',
      unit: 'm',
      axes: [{ name: 'positions' }],
    },
    small: { dtype: 'float16', tensorOrder: 0, quantityKind: 'Length', unit: 'm', axes: [{ name: 'samples' }] },
    integer: { dtype: 'int64', tensorOrder: 0, axes: [{ name: 'samples' }] },
    flags: { dtype: 'bool', tensorOrder: 0, axes: [{ name: 'samples' }] },
  }
  const values: Record<string, RecordedDataTensor> = {
    signal: {
      shape: [3],
      axes: [{ ticks: ['first', 'second', 'third'] }],
      storage: { kind: 'inline', value: [1.25, 2.5, -4] },
    },
    label: { shape: [], storage: { kind: 'inline', value: '한글 결과' } },
    vector: {
      shape: [2, 3],
      axes: [{ ticks: [10, 20] }],
      storage: {
        kind: 'inline',
        value: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      },
    },
    small: { shape: [3], axes: [{ implicitOrdinal: true }], storage: { kind: 'inline', value: [0.5, -2, 4] } },
    integer: {
      shape: [3],
      axes: [{ implicitOrdinal: true }],
      storage: { kind: 'inline', value: [-123456789, 0, 123456789] },
    },
    flags: { shape: [3], axes: [{ implicitOrdinal: true }], storage: { kind: 'inline', value: [true, false, true] } },
  }
  const attachments = []
  for (const name of ['signal', 'small', 'integer', 'flags']) {
    const tensor = values[name]
    const bytes = createDataTensorAccessor(schema[name as keyof typeof schema] as DataSchema, tensor).rawBytes()
    const slices = [bytes.slice(0, 3), bytes.slice(3)]
    const ids = []
    for (const [index, bytes] of slices.entries()) {
      const id = `${name}-${index}`
      const file = `records/${id}.bin`
      await writeFile(path.join(result, file), bytes)
      ids.push(id)
      attachments.push({ id, path: file, byteLength: bytes.byteLength, mimeType: 'application/octet-stream' })
    }
    values[name] = { ...tensor, storage: { kind: 'attachments', ids, byteLength: bytes.byteLength } }
  }
  const sourceBundle = { files: { 'experiment.tsx': '// Local result protocol fixture.\n' } }
  const sourceHash = await cadSourceHash({ kind: 'experiment', sourceBundle })
  const input = Buffer.from(
    JSON.stringify({
      measurement: {
        kind: 'measurement',
        experiment: { sourceHash, simulationProgram: { recordedData: { group: schema } } },
      },
    }),
    'utf8',
  )
  const inputHash = createHash('sha256').update(input).digest('hex')
  await writeFile(path.join(artifact, 'items/1.json'), input)
  await writeFile(
    path.join(artifact, 'manifest.json'),
    JSON.stringify({
      kind: 'caemble.build',
      version: 2,
      source_hash: sourceHash,
      catalog_revision: 'fixture-catalog',
      builder_version: '2',
      mode: 'generate',
      source_bundle: sourceBundle,
      items: [{ index: 1, file: 'items/1.json', input_hash: inputHash, byte_length: input.byteLength }],
    }),
    'utf8',
  )
  const record = { name: 'group', sequence: 1, path: 'records/0001.json', schema, attachments }
  await writeFile(path.join(result, record.path), JSON.stringify({ ...record, value: values }), 'utf8')
  await writeFile(
    path.join(result, 'manifest.json'),
    JSON.stringify({
      kind: 'local-cae-result',
      state: 'succeeded',
      input: path.join(artifact, 'items/1.json'),
      inputHash,
      sourceHash,
      catalogRevision: 'fixture-catalog',
      jobId: 'local-fixture',
      records: [record],
      recordSequences: [1],
      recordedBytes: 100,
      trace: [],
    }),
    'utf8',
  )
  return { result, artifact }
}

describe('local CAE result adapter', () => {
  it('exports frozen input, record JSON and exact binary files into an independently movable directory', async () => {
    const { result, artifact } = await fixture()
    const root = path.dirname(artifact)
    const output = path.join(root, 'export')
    const expected = await createLocalCalculationInput(result)
    const expectedBinary = await readFile(path.join(result, 'records/signal-1.bin'))
    const exported = await dataCommand('data', 'export', {
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
      args: [],
      options: { result, out: output },
      signal: new AbortController().signal,
      client: () => {
        throw new Error('Local export must not call the server.')
      },
    })
    expect(exported).toMatchObject({ path: output, kind: 'local-cae-result' })
    expect(JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')).input).toBe('artifact/items/1.json')
    const moved = path.join(root, '이동한 결과')
    await rename(output, moved)
    await rm(artifact, { recursive: true })
    await rm(result, { recursive: true })
    expect(await readFile(path.join(moved, 'records/signal-1.bin'))).toEqual(expectedBinary)
    expect(await createLocalCalculationInput(moved)).toEqual(expected)
    expect(await sliceLocalResult(moved, 'group.signal', { offset: 1, limit: 2 })).toMatchObject({ values: [2.5, -4] })
    expect((await inspectLocalResult(moved)).manifest.input).toBe(path.join(moved, 'artifact/items/1.json'))
  })

  it('refuses to overwrite an export and rejects truncated attachments before publishing a manifest', async () => {
    const { result, artifact } = await fixture()
    await expect(exportLocalResult(result, result)).rejects.toThrow('must be empty')
    await writeFile(path.join(result, 'records/signal-0.bin'), Buffer.alloc(0))
    const output = path.join(path.dirname(artifact), 'incomplete-export')
    await expect(exportLocalResult(result, output)).rejects.toThrow('attachment size changed')
    await expect(readFile(path.join(output, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('selects a single parent result and asks for an explicit directory for multiple executions', async () => {
    const { result } = await fixture()
    const first = `${result}-first`
    await rename(result, first)
    await mkdir(result)
    await rename(first, path.join(result, '1'))
    const manifest = { kind: 'caemble.local-executions', executions: [{}] }
    await writeFile(path.join(result, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    expect((await createLocalCalculationInput(result, ['group.label']))['group.label'].data).toBe('한글 결과')
    await writeFile(path.join(result, 'manifest.json'), JSON.stringify({ ...manifest, executions: [{}, {}] }), 'utf8')
    await expect(inspectLocalResult(result)).rejects.toThrow('Select one local execution directory:')
  })

  it('preserves group paths, dtype, tensor order, binary numbers and actual axes in Calculation input', async () => {
    const { result } = await fixture()
    const input = await createLocalCalculationInput(result)
    expect(input['group.signal']).toEqual({
      dtype: 'float64',
      tensorOrder: 0,
      quantityKind: 'Length',
      unit: 'm',
      shape: [3],
      data: [1.25, 2.5, -4],
      axes: [{ name: 'samples', ticks: ['first', 'second', 'third'] }],
    })
    expect(input['group.label'].data).toBe('한글 결과')
    expect(input['group.vector']).toMatchObject({
      shape: [2, 3],
      tensorOrder: 1,
      data: [1, 2, 3, 4, 5, 6],
      axes: [{ name: 'positions', ticks: [10, 20] }],
    })
    expect(input['group.small'].data).toEqual([0.5, -2, 4])
    expect(input['group.integer'].data).toEqual([-123456789, 0, 123456789])
    expect(input['group.flags'].data).toEqual([true, false, true])
    expect(Object.keys(await createLocalCalculationInput(result, ['group.label']))).toEqual(['group.label'])
  })

  it('inspects metadata without attachment reads and slices across binary shard boundaries', async () => {
    const { result } = await fixture()
    expect(await sliceLocalResult(result, 'group.signal', { offset: 0, limit: 2 })).toMatchObject({
      values: [1.25, 2.5],
      shape: [3],
      total: 3,
    })
    expect(await sliceLocalResult(result, 'group.integer', { offset: 1, limit: 2 })).toMatchObject({
      values: [0, 123456789],
    })
    expect(await sliceLocalResult(result, 'group.label')).toMatchObject({ values: ['한글 결과'] })
    await writeFile(path.join(result, 'records/signal-0.bin'), Buffer.alloc(0))
    expect((await inspectLocalResult(result)).records.find((record) => record.name === 'group.signal')).toMatchObject({
      present: true,
      shape: [3],
      byteLength: 24,
    })
    await expect(createLocalCalculationInput(result)).rejects.toThrow('attachment size changed')
  })

  it('rejects modified original input, schema and catalog provenance', async () => {
    const { result, artifact } = await fixture()
    const manifestPath = path.join(result, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, catalogRevision: 'other-catalog' }), 'utf8')
    await expect(createLocalCalculationInput(result)).rejects.toThrow('provenance')
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, records: [{ ...manifest.records[0], schema: {} }] }),
      'utf8',
    )
    await expect(createLocalCalculationInput(result)).rejects.toThrow('schema differs')
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    await writeFile(path.join(artifact, 'items/1.json'), '{}', 'utf8')
    await expect(createLocalCalculationInput(result)).rejects.toThrow('has changed')
  })

  it('rejects unfinished runs, unknown leaves and unbounded slices', async () => {
    const { result } = await fixture()
    await expect(createLocalCalculationInput(result, ['group.missing'])).rejects.toThrow('not declared')
    await expect(sliceLocalResult(result, 'group.signal', { limit: 10001 })).rejects.toThrow('between 0 and 10000')
    const manifestPath = path.join(result, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'cancelled' }), 'utf8')
    await expect(createLocalCalculationInput(result)).rejects.toThrow('successful local result')
  })
})
