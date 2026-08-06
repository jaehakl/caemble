import type {
  DefinedKernelTask,
  KernelArtifactTypes,
  KernelIdentity,
  KernelInputTypes,
  KernelObservationTypes,
  RecordedDataSpec,
  SimulationProgramManifest,
} from './types'

export function defineKernelTask<
  Config,
  Artifacts extends KernelArtifactTypes = KernelArtifactTypes,
  Observations extends KernelObservationTypes = KernelObservationTypes,
  Inputs extends KernelInputTypes = KernelInputTypes,
>(kernel: KernelIdentity, config: NoInfer<Config>): DefinedKernelTask<Config, Artifacts, Observations, Inputs> {
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

function configurationHash(value: unknown) {
  const text = stableJson(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function simulationProgramManifest(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: Readonly<Record<string, RecordedDataSpec>>,
  programHash: string,
): SimulationProgramManifest {
  return Object.freeze({
    formatVersion: 1 as const,
    programHash,
    tasks: Object.freeze(
      Object.fromEntries(
        Object.entries(tasks).map(([name, task]) => [
          name,
          Object.freeze({
            kernel: Object.freeze({ ...task.kernel }),
            configHash: configurationHash(task.config),
          }),
        ]),
      ),
    ),
    recordedData: Object.freeze(
      Object.fromEntries(
        Object.entries(recordedData).map(([name, spec]) => [
          name,
          Object.freeze({
            ...spec,
            ...(spec.basis === undefined
              ? {}
              : { basis: Object.freeze(spec.basis.map((axis) => Object.freeze([...axis]))) }),
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
          }),
        ]),
      ),
    ) as Readonly<Record<string, RecordedDataSpec>>,
  })
}
