import type {
  DefinedKernelTask,
  KernelIdentity,
  RecordedDataSpec,
  ResolvedDataSchema,
  SimulationProgramManifest,
} from './types'
import { getQuantityKindTensorOrder, normalizeQuantityMetadata } from '../../quantitykind/runtime'

export function defineTask<Config>(kernel: KernelIdentity, config: NoInfer<Config>): DefinedKernelTask<Config> {
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
  }) as DefinedKernelTask<Config>
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

function canonicalValue(value: unknown) {
  return JSON.parse(stableJson(value)) as unknown
}

export function canonicalRecordedDataSpec(spec: RecordedDataSpec, path = 'RecordedData'): ResolvedDataSchema {
  const quantityMetadata = spec.dtype.startsWith('float') ? normalizeQuantityMetadata(spec, path) : null
  return Object.freeze({
    ...spec,
    ...(quantityMetadata ?? {}),
    tensorOrder: quantityMetadata === null ? 0 : getQuantityKindTensorOrder(quantityMetadata.quantityKind),
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
  }) as ResolvedDataSchema
}

export function simulationProgramManifest(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: Readonly<Record<string, RecordedDataSpec>>,
  pythonSource: string,
): SimulationProgramManifest {
  if (!pythonSource.trim()) {
    throw new Error('Simulation Program requires non-empty Python source.')
  }
  const canonicalRecordedData = Object.freeze(
    Object.fromEntries(
      Object.entries(recordedData).map(([name, spec]) => [
        name,
        canonicalRecordedDataSpec(spec, `RecordedData ${JSON.stringify(name)}`),
      ]),
    ),
  ) as Readonly<Record<string, ResolvedDataSchema>>
  return Object.freeze({
    formatVersion: 5 as const,
    simulationApiVersion: 3 as const,
    pythonSource,
    tasks: Object.freeze(
      Object.fromEntries(
        Object.entries(tasks).map(([name, task]) => {
          return [
            name,
            Object.freeze({
              kernel: Object.freeze({ ...task.kernel }),
              config: canonicalValue(task.config),
            }),
          ]
        }),
      ),
    ),
    recordedData: canonicalRecordedData,
  })
}
