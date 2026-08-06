import type {
  DefinedKernelTask,
  KernelArtifactTypes,
  KernelIdentity,
  KernelInputTypes,
  KernelObservationTypes,
  RecordedDataSpec,
  SimulationProgramManifest,
} from './types'
import { normalizeQuantityMetadata } from '../quantitykind/runtime'
import {
  normalizeKernelTaskConfig,
  resolveKernelOutputSpecs,
  type KernelDescriptor,
  type KernelTaskConfig,
} from './kernelContract'

export function defineKernelTask<
  Config,
  Artifacts extends KernelArtifactTypes = KernelArtifactTypes,
  Observations extends KernelObservationTypes = KernelObservationTypes,
  Inputs extends KernelInputTypes = KernelInputTypes,
>(
  kernel: KernelIdentity | KernelDescriptor,
  config: NoInfer<Config>,
): DefinedKernelTask<Config, Artifacts, Observations, Inputs> {
  if (
    !kernel ||
    typeof kernel !== 'object' ||
    typeof kernel.name !== 'string' ||
    !kernel.name.trim() ||
    typeof kernel.version !== 'string' ||
    !kernel.version.trim()
  ) {
    throw new Error('Kernel tasks require a non-empty kernel name and version.')
  }
  return Object.freeze({
    kind: 'caemble-kernel-task' as const,
    kernel: Object.freeze({
      name: kernel.name.trim(),
      version: kernel.version.trim(),
    }),
    config,
    ...('referenceLengthUnit' in kernel ? { descriptor: kernel } : {}),
  }) as DefinedKernelTask<Config, Artifacts, Observations, Inputs>
}

function stableJson(value: unknown): string {
  const ancestors = new Set<unknown>()
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new Error('Kernel task configuration must not be circular.')
      ancestors.add(current)
      const normalized = current.map(normalize)
      ancestors.delete(current)
      return normalized
    }
    if (current && typeof current === 'object') {
      if (ancestors.has(current)) throw new Error('Kernel task configuration must not be circular.')
      ancestors.add(current)
      const normalized = Object.fromEntries(
        Object.entries(current)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      )
      ancestors.delete(current)
      return normalized
    }
    if (
      current === null ||
      typeof current === 'boolean' ||
      typeof current === 'string' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      return current
    }
    throw new Error('Kernel task configuration must contain only serializable finite values.')
  }
  return JSON.stringify(normalize(value))
}

export function canonicalDataHash(value: unknown) {
  let hash = 0x811c9dc5
  const ancestors = new Set<unknown>()
  const textEncoder = new TextEncoder()
  const textDecoder = new TextDecoder()
  const numberBytes = new ArrayBuffer(8)
  const numberView = new DataView(numberBytes)
  const appendByte = (byte: number) => {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  const appendBytes = (bytes: Uint8Array) => bytes.forEach(appendByte)
  const appendLength = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
      throw new Error('Canonical data collections and strings must fit in a uint32 length.')
    }
    appendByte(length & 0xff)
    appendByte((length >>> 8) & 0xff)
    appendByte((length >>> 16) & 0xff)
    appendByte((length >>> 24) & 0xff)
  }
  const utf8 = (text: string) => {
    const bytes = textEncoder.encode(text)
    if (textDecoder.decode(bytes) !== text) {
      throw new Error('Canonical data strings must contain valid Unicode scalar values.')
    }
    return bytes
  }
  const appendString = (bytes: Uint8Array) => {
    appendByte(0x04)
    appendLength(bytes.byteLength)
    appendBytes(bytes)
  }
  const compareBytes = (left: Uint8Array, right: Uint8Array) => {
    const length = Math.min(left.byteLength, right.byteLength)
    for (let index = 0; index < length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index]
    }
    return left.byteLength - right.byteLength
  }
  const append = (current: unknown): void => {
    if (current === null) {
      appendByte(0x00)
      return
    }
    if (current === false) {
      appendByte(0x01)
      return
    }
    if (current === true) {
      appendByte(0x02)
      return
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('Canonical data numbers must be finite.')
      appendByte(0x03)
      numberView.setFloat64(0, Object.is(current, -0) ? 0 : current, true)
      appendBytes(new Uint8Array(numberBytes))
      return
    }
    if (typeof current === 'string') {
      appendString(utf8(current))
      return
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new Error('Canonical data must not be circular.')
      ancestors.add(current)
      appendByte(0x05)
      appendLength(current.length)
      for (let index = 0; index < current.length; index += 1) append(current[index])
      ancestors.delete(current)
      return
    }
    if (typeof current === 'object') {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(current))) {
        throw new Error('Canonical data objects must be plain objects.')
      }
      if (ancestors.has(current)) throw new Error('Canonical data must not be circular.')
      ancestors.add(current)
      const entries = Object.entries(current)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => ({ key: utf8(key), item }))
        .sort((left, right) => compareBytes(left.key, right.key))
      appendByte(0x06)
      appendLength(entries.length)
      entries.forEach(({ key, item }) => {
        appendString(key)
        append(item)
      })
      ancestors.delete(current)
      return
    }
    throw new Error('Canonical data must contain only null, booleans, finite numbers, strings, arrays, and objects.')
  }

  append(value)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function canonicalValue(value: unknown) {
  return JSON.parse(stableJson(value)) as unknown
}

export function canonicalRecordedDataSpec(spec: RecordedDataSpec, path = 'RecordedData'): RecordedDataSpec {
  const quantityMetadata = spec.dtype.startsWith('float') ? normalizeQuantityMetadata(spec, path) : {}
  return Object.freeze({
    ...spec,
    ...quantityMetadata,
    ...(spec.axes === undefined
      ? {}
      : {
          axes: Object.freeze(
            spec.axes.map((axis) =>
              Object.freeze({
                ...axis,
                ...(axis.ticks === undefined ? {} : { ticks: Object.freeze([...axis.ticks]) }),
              }),
            ),
          ),
        }),
  }) as RecordedDataSpec
}

export function simulationProgramManifest(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: Readonly<Record<string, RecordedDataSpec>>,
  programHash: string,
  pythonSource: string,
  pythonSourceHash: string,
): SimulationProgramManifest {
  if (!pythonSource.trim() || !/^[0-9a-f]{64}$/.test(pythonSourceHash)) {
    throw new Error('Simulation Program requires non-empty Python source and its SHA-256 hash.')
  }
  const canonicalRecordedData = Object.freeze(
    Object.fromEntries(
      Object.entries(recordedData).map(([name, spec]) => [
        name,
        canonicalRecordedDataSpec(spec, `RecordedData ${JSON.stringify(name)}`),
      ]),
    ),
  ) as Readonly<Record<string, RecordedDataSpec>>
  return Object.freeze({
    formatVersion: 2 as const,
    programHash,
    simulationApiVersion: 1 as const,
    pythonSource,
    pythonSourceHash,
    tasks: Object.freeze(
      Object.fromEntries(
        Object.entries(tasks).map(([name, task]) => {
          const descriptor = task.descriptor ?? null
          const config = descriptor
            ? normalizeKernelTaskConfig(descriptor, task.config as KernelTaskConfig)
            : canonicalValue(task.config)
          return [
            name,
            Object.freeze({
              kernel: Object.freeze({
                ...task.kernel,
                descriptorHash: canonicalDataHash(descriptor ?? task.kernel),
              }),
              descriptor,
              config,
              configHash: canonicalDataHash(config),
              outputArtifacts: descriptor ? resolveKernelOutputSpecs(descriptor, config as KernelTaskConfig) : {},
            }),
          ]
        }),
      ),
    ),
    recordedData: canonicalRecordedData,
    recordedDataSchemaHash: canonicalDataHash(canonicalRecordedData),
  })
}
