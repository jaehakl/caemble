import { isFloatDType } from '../cad/model/core'
import { normalizeQuantityMetadata } from '../quantitykind/runtime'
import { canonicalDataHash } from './authoring'
import {
  assertKernelArtifactPayload,
  assertValidKernelDescriptor,
  normalizeKernelTaskConfig,
  resolveKernelOutputSpecs,
  type KernelDataSpec,
  type KernelDescriptor,
  type KernelTaskConfig,
} from './kernelContract'
import type { RecordedDataSpec, SimulationProgramManifest, SimulationResult } from './types'

const dataDTypes = new Set([
  'bool',
  'string',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float16',
  'float32',
  'float64',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const invalid = Reflect.ownKeys(value).filter((key) => typeof key !== 'string' || !keys.includes(key))
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (invalid.length > 0 || missing.length > 0) {
    throw new Error(`${path} must contain exactly ${keys.join(', ')}.`)
  }
}

function assertRecordedDataSpec(value: unknown, path: string): asserts value is RecordedDataSpec {
  if (!isPlainObject(value) || typeof value.dtype !== 'string' || !dataDTypes.has(value.dtype)) {
    throw new Error(`${path} must declare a supported dtype.`)
  }
  const specKeys = ['dtype']
  if (value.unit !== undefined) specKeys.push('unit')
  if (value.quantityKind !== undefined) specKeys.push('quantityKind')
  if (value.basis !== undefined) specKeys.push('basis')
  if (value.axes !== undefined) specKeys.push('axes')
  assertExactKeys(value, specKeys, path)
  const hasUnit = Object.prototype.hasOwnProperty.call(value, 'unit')
  const hasQuantityKind = Object.prototype.hasOwnProperty.call(value, 'quantityKind')
  const hasBasis = Object.prototype.hasOwnProperty.call(value, 'basis')
  if (isFloatDType(value.dtype as never)) {
    normalizeQuantityMetadata(value, path)
  } else if (hasUnit || hasQuantityKind || hasBasis) {
    throw new Error(`${path} quantity metadata is allowed only for float dtypes.`)
  }
  if (value.axes !== undefined) {
    if (!Array.isArray(value.axes) || value.axes.length === 0) {
      throw new Error(`${path}.axes must be a non-empty array when specified.`)
    }
    value.axes.forEach((axis, index) => {
      const axisPath = `${path}.axes[${index}]`
      if (!isPlainObject(axis)) throw new Error(`${axisPath} must be an object.`)
      const axisKeys: string[] = []
      if (axis.length !== undefined) axisKeys.push('length')
      if (axis.name !== undefined) axisKeys.push('name')
      if (axis.ticks !== undefined) axisKeys.push('ticks')
      if (axis.unit !== undefined) axisKeys.push('unit')
      if (axis.quantityKind !== undefined) axisKeys.push('quantityKind')
      assertExactKeys(axis, axisKeys, axisPath)
      if (axis.length !== undefined && (!Number.isSafeInteger(axis.length) || (axis.length as number) <= 0)) {
        throw new Error(`${axisPath}.length must be a positive safe integer.`)
      }
      if (axis.ticks !== undefined) {
        if (!Array.isArray(axis.ticks) || axis.length === undefined || axis.ticks.length !== axis.length) {
          throw new Error(`${axisPath}.ticks must match its fixed axis length.`)
        }
        if (
          axis.ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))
        ) {
          throw new Error(`${axisPath}.ticks must contain only finite numbers or strings.`)
        }
      }
      const axisHasUnit = Object.prototype.hasOwnProperty.call(axis, 'unit')
      const axisHasQuantityKind = Object.prototype.hasOwnProperty.call(axis, 'quantityKind')
      if (axisHasUnit !== axisHasQuantityKind) {
        throw new Error(`${axisPath} must specify unit and quantityKind together.`)
      }
      if (axisHasUnit) normalizeQuantityMetadata(axis, axisPath, true)
    })
  }
}

function assertProvenanceVars(value: unknown, path: string) {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`)
  const active = new Set<unknown>()
  const assertTensor = (tensor: unknown, tensorPath: string) => {
    if (typeof tensor === 'number' && Number.isFinite(tensor)) return
    if (!Array.isArray(tensor) || active.has(tensor)) {
      throw new Error(`${tensorPath} must be a finite numeric tensor.`)
    }
    active.add(tensor)
    tensor.forEach((item, index) => assertTensor(item, `${tensorPath}[${index}]`))
    active.delete(tensor)
  }
  Object.entries(value).forEach(([name, tensor]) => assertTensor(tensor, `${path}.${name}`))
}

export function assertSimulationProgramManifest(value: unknown): asserts value is SimulationProgramManifest {
  if (
    !isPlainObject(value) ||
    value.formatVersion !== 2 ||
    typeof value.programHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.programHash) ||
    value.simulationApiVersion !== 1 ||
    typeof value.pythonSource !== 'string' ||
    !value.pythonSource.trim() ||
    typeof value.pythonSourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.pythonSourceHash) ||
    !isPlainObject(value.tasks) ||
    Object.keys(value.tasks).length === 0 ||
    !isPlainObject(value.recordedData) ||
    typeof value.recordedDataSchemaHash !== 'string' ||
    !/^[0-9a-f]{8}$/.test(value.recordedDataSchemaHash)
  ) {
    throw new Error('Simulation Program manifest is invalid.')
  }
  assertExactKeys(
    value,
    [
      'formatVersion',
      'programHash',
      'simulationApiVersion',
      'pythonSource',
      'pythonSourceHash',
      'tasks',
      'recordedData',
      'recordedDataSchemaHash',
    ],
    'Simulation Program manifest',
  )
  Object.entries(value.tasks).forEach(([taskName, task]) => {
    if (
      !taskName.trim() ||
      !isPlainObject(task) ||
      !isPlainObject(task.kernel) ||
      typeof task.kernel.name !== 'string' ||
      !task.kernel.name.trim() ||
      typeof task.kernel.version !== 'string' ||
      !task.kernel.version.trim() ||
      typeof task.kernel.descriptorHash !== 'string' ||
      !/^[0-9a-f]{8}$/.test(task.kernel.descriptorHash) ||
      typeof task.configHash !== 'string' ||
      !/^[0-9a-f]{8}$/.test(task.configHash) ||
      !isPlainObject(task.outputArtifacts)
    ) {
      throw new Error(`Simulation Program task "${taskName}" is invalid.`)
    }
    assertExactKeys(
      task,
      ['kernel', 'descriptor', 'config', 'configHash', 'outputArtifacts'],
      `Simulation Program task "${taskName}"`,
    )
    assertExactKeys(task.kernel, ['name', 'version', 'descriptorHash'], `Simulation Program task "${taskName}".kernel`)
    if (task.descriptor !== null) {
      if (!isPlainObject(task.descriptor)) {
        throw new Error(`Simulation Program task "${taskName}" descriptor is invalid.`)
      }
      const descriptor = task.descriptor as unknown as KernelDescriptor
      assertValidKernelDescriptor(descriptor)
      if (
        descriptor.name !== task.kernel.name ||
        descriptor.version !== task.kernel.version ||
        canonicalDataHash(descriptor) !== task.kernel.descriptorHash
      ) {
        throw new Error(`Simulation Program task "${taskName}" descriptor does not match its kernel identity.`)
      }
      const normalizedConfig = normalizeKernelTaskConfig(descriptor, task.config as KernelTaskConfig)
      if (canonicalDataHash(normalizedConfig) !== task.configHash) {
        throw new Error(`Simulation Program task "${taskName}" config is not canonical for its descriptor.`)
      }
      const resolvedOutputs = resolveKernelOutputSpecs(descriptor, normalizedConfig)
      if (canonicalDataHash(resolvedOutputs) !== canonicalDataHash(task.outputArtifacts)) {
        throw new Error(`Simulation Program task "${taskName}" resolved output specs are invalid.`)
      }
    } else if (
      canonicalDataHash({ name: task.kernel.name, version: task.kernel.version }) !== task.kernel.descriptorHash
    ) {
      throw new Error(`Simulation Program task "${taskName}" descriptor hash is invalid.`)
    }
    if (canonicalDataHash(task.config) !== task.configHash) {
      throw new Error(`Simulation Program task "${taskName}" config hash is invalid.`)
    }
    Object.entries(task.outputArtifacts).forEach(([name, output]) => {
      if (
        !name.trim() ||
        !isPlainObject(output) ||
        typeof output.artifactType !== 'string' ||
        !output.artifactType ||
        !isPlainObject(output.data)
      ) {
        throw new Error(`Simulation Program task "${taskName}" output "${name}" is invalid.`)
      }
      assertExactKeys(output, ['artifactType', 'data'], `Simulation Program task "${taskName}" output "${name}"`)
      assertRecordedDataSpec(output.data, `Simulation Program task "${taskName}" output "${name}".data`)
    })
  })
  Object.entries(value.recordedData).forEach(([name, spec]) => {
    if (!name.trim()) throw new Error('RecordedData names must not be empty.')
    assertRecordedDataSpec(spec, `Simulation Program recordedData "${name}"`)
  })
  if (canonicalDataHash(value.recordedData) !== value.recordedDataSchemaHash) {
    throw new Error('Simulation Program RecordedData schema hash is invalid.')
  }
}

export function assertSimulationResult(value: unknown): asserts value is SimulationResult {
  if (
    !isPlainObject(value) ||
    value.format !== 'caemble-run' ||
    value.formatVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !Number.isSafeInteger(value.finalStateRevision) ||
    (value.finalStateRevision as number) < 0 ||
    !isPlainObject(value.recordedData) ||
    !Array.isArray(value.trace) ||
    !isPlainObject(value.provenance)
  ) {
    throw new Error('Simulation result envelope is invalid.')
  }
  assertExactKeys(
    value,
    ['format', 'formatVersion', 'runId', 'finalStateRevision', 'recordedData', 'trace', 'provenance'],
    'Simulation result',
  )
  Object.entries(value.recordedData).forEach(([name, entry]) => {
    if (!name.trim() || !isPlainObject(entry) || !isPlainObject(entry.spec)) {
      throw new Error(`Simulation RecordedData "${name}" is invalid.`)
    }
    assertExactKeys(entry, ['spec', 'data'], `Simulation RecordedData "${name}"`)
    assertRecordedDataSpec(entry.spec, `Simulation RecordedData "${name}".spec`)
    assertKernelArtifactPayload(entry.spec as KernelDataSpec, entry.data, `Simulation RecordedData "${name}".data`)
  })
  value.trace.forEach((entry, index) => {
    if (
      !isPlainObject(entry) ||
      entry.sequence !== index + 1 ||
      typeof entry.task !== 'string' ||
      !entry.task.trim() ||
      !isPlainObject(entry.kernel) ||
      !isPlainObject(entry.inputArtifacts) ||
      (entry.status !== 'succeeded' && entry.status !== 'failed')
    ) {
      throw new Error(`Simulation trace entry ${index} is invalid.`)
    }
    const traceKeys = [
      'sequence',
      'task',
      'kernel',
      'inputStateRevision',
      'outputStateRevision',
      'inputArtifacts',
      'status',
      'startedAt',
      'finishedAt',
    ]
    if (entry.error !== undefined) traceKeys.push('error')
    assertExactKeys(entry, traceKeys, `Simulation trace entry ${index}`)
    if (
      !Number.isSafeInteger(entry.inputStateRevision) ||
      (entry.inputStateRevision as number) < 0 ||
      (entry.outputStateRevision !== null && !Number.isSafeInteger(entry.outputStateRevision)) ||
      (typeof entry.outputStateRevision === 'number' && entry.outputStateRevision < 0) ||
      typeof entry.startedAt !== 'number' ||
      !Number.isFinite(entry.startedAt) ||
      typeof entry.finishedAt !== 'number' ||
      !Number.isFinite(entry.finishedAt) ||
      entry.finishedAt < entry.startedAt ||
      (entry.error !== undefined && typeof entry.error !== 'string')
    ) {
      throw new Error(`Simulation trace entry ${index} has invalid revisions or timing.`)
    }
    assertExactKeys(entry.kernel, ['name', 'version'], `Simulation trace entry ${index}.kernel`)
    if (
      typeof entry.kernel.name !== 'string' ||
      !entry.kernel.name.trim() ||
      typeof entry.kernel.version !== 'string' ||
      !entry.kernel.version.trim()
    ) {
      throw new Error(`Simulation trace entry ${index}.kernel is invalid.`)
    }
    Object.entries(entry.inputArtifacts).forEach(([name, rawArtifact]) => {
      const entries = Array.isArray(rawArtifact) ? rawArtifact : [rawArtifact]
      entries.forEach((artifact, artifactIndex) => {
        if (
          !isPlainObject(artifact) ||
          typeof artifact.id !== 'string' ||
          !artifact.id ||
          typeof artifact.artifactType !== 'string' ||
          !artifact.artifactType
        ) {
          throw new Error(`Simulation trace entry ${index} input "${name}" artifact ${artifactIndex} is invalid.`)
        }
        assertExactKeys(
          artifact,
          ['id', 'artifactType'],
          `Simulation trace entry ${index} input "${name}" artifact ${artifactIndex}`,
        )
      })
    })
  })
  assertExactKeys(
    value.provenance,
    [
      'programHash',
      'structureSourceHash',
      'experimentSourceHash',
      'structureSeed',
      'experimentSeed',
      'structureVars',
      'experimentVars',
      'kernels',
    ],
    'Simulation provenance',
  )
  if (
    typeof value.provenance.programHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.provenance.programHash) ||
    typeof value.provenance.structureSourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.provenance.structureSourceHash) ||
    typeof value.provenance.experimentSourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.provenance.experimentSourceHash) ||
    !Number.isSafeInteger(value.provenance.structureSeed) ||
    (value.provenance.structureSeed as number) < 0 ||
    !Number.isSafeInteger(value.provenance.experimentSeed) ||
    (value.provenance.experimentSeed as number) < 0 ||
    !Array.isArray(value.provenance.kernels)
  ) {
    throw new Error('Simulation provenance identity is invalid.')
  }
  assertProvenanceVars(value.provenance.structureVars, 'Simulation provenance.structureVars')
  assertProvenanceVars(value.provenance.experimentVars, 'Simulation provenance.experimentVars')
  const kernelIdentities = new Set<string>()
  value.provenance.kernels.forEach((kernel, index) => {
    if (!isPlainObject(kernel)) throw new Error(`Simulation provenance kernel ${index} is invalid.`)
    assertExactKeys(kernel, ['name', 'version'], `Simulation provenance kernel ${index}`)
    if (
      typeof kernel.name !== 'string' ||
      !kernel.name.trim() ||
      typeof kernel.version !== 'string' ||
      !kernel.version.trim() ||
      kernelIdentities.has(JSON.stringify([kernel.name, kernel.version]))
    ) {
      throw new Error(`Simulation provenance kernel ${index} is invalid or duplicated.`)
    }
    kernelIdentities.add(JSON.stringify([kernel.name, kernel.version]))
  })
}
