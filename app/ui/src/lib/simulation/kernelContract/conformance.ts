import { CadModelError } from '../../cad/model/core'
import { SimulationKernelError } from '../errors'
import type { KernelDefinition, KernelPrepareContext, KernelTaskConfig, KernelWorld } from './types'
import {
  assertKernelExecutionResult,
  assertValidKernelDescriptor,
  normalizeKernelArtifactPayload,
  normalizeKernelTaskConfig,
  resolveKernelInputPort,
  resolveKernelOutputSpecs,
} from './validation'

export async function runKernelConformance<Prepared, Config extends KernelTaskConfig, World extends KernelWorld>(
  definition: KernelDefinition<Prepared, Config, World>,
  context: KernelPrepareContext<Config, World>,
  options: Readonly<{
    state?: unknown
    inputs?: Readonly<Record<string, unknown>>
    signal?: AbortSignal
  }> = {},
) {
  assertValidKernelDescriptor(definition.descriptor)
  const config = normalizeKernelTaskConfig(definition.descriptor, context.config, context.world) as Config
  Object.keys(options.inputs ?? {}).forEach((name) => {
    if (!resolveKernelInputPort(definition.descriptor, name)) {
      throw new CadModelError(`Kernel conformance input ${name} is not declared.`)
    }
  })
  const inputs = Object.create(null) as Record<string, unknown>
  Object.entries(definition.descriptor.inputPorts).forEach(([name, port]) => {
    const raw =
      options.inputs && Object.prototype.hasOwnProperty.call(options.inputs, name) ? options.inputs[name] : undefined
    const values = raw === undefined ? [] : port.maximumOccurrences === 1 ? [raw] : Array.isArray(raw) ? raw : [raw]
    if (values.length < port.minimumOccurrences || values.length > port.maximumOccurrences) {
      throw new CadModelError(
        `Kernel conformance input ${name} requires ${port.minimumOccurrences}..${port.maximumOccurrences} values.`,
      )
    }
    const normalized = port.data
      ? values.map((value, index) => normalizeKernelArtifactPayload(port.data!, value, `inputs.${name}[${index}]`))
      : values
    if (normalized.length > 0) {
      inputs[name] = port.maximumOccurrences === 1 ? normalized[0] : Object.freeze(normalized)
    }
  })
  resolveKernelOutputSpecs(definition.descriptor, config)
  const prepared = await definition.prepare({ ...context, config })
  const progress: Array<Readonly<{ stage: string; completed: number; total?: number }>> = []
  const latestProgress = new Map<string, Readonly<{ completed: number; total?: number }>>()
  const result = await definition.execute(
    {
      prepared: prepared.prepared,
      state: options.state === undefined ? undefined : structuredClone(options.state),
      inputs: Object.freeze(inputs),
    },
    {
      signal: options.signal ?? new AbortController().signal,
      reportProgress(event) {
        if (
          !event.stage.trim() ||
          !Number.isFinite(event.completed) ||
          event.completed < 0 ||
          (event.total !== undefined && (!Number.isFinite(event.total) || event.total < event.completed))
        ) {
          throw new CadModelError('Kernel emitted invalid progress.')
        }
        const previous = latestProgress.get(event.stage)
        if (
          previous &&
          (event.completed < previous.completed ||
            (previous.total !== undefined && event.total !== undefined && previous.total !== event.total))
        ) {
          throw new CadModelError(`Kernel progress for stage ${event.stage} is not monotonic.`)
        }
        latestProgress.set(event.stage, event)
        progress.push(Object.freeze({ ...event }))
      },
    },
  )
  if (progress.length === 0) throw new CadModelError('Kernel did not report progress.')
  return Object.freeze({
    config,
    prepared: prepared.prepared,
    progress: Object.freeze(progress),
    result: assertKernelExecutionResult(definition.descriptor, config, result),
  })
}

export async function assertKernelCancellationConformance<
  Prepared,
  Config extends KernelTaskConfig,
  World extends KernelWorld,
>(definition: KernelDefinition<Prepared, Config, World>, prepared: Prepared) {
  const controller = new AbortController()
  controller.abort()
  try {
    await definition.execute(
      { prepared, state: undefined, inputs: {} },
      { signal: controller.signal, reportProgress() {} },
    )
  } catch (error) {
    if (error instanceof SimulationKernelError && error.kind === 'resource') return
    throw new CadModelError(
      `Kernel cancellation must throw a resource SimulationKernelError; received ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }.`,
    )
  }
  throw new CadModelError('Kernel cancellation must not succeed.')
}
