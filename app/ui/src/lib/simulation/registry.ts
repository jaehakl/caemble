import type { KernelDefinition, KernelDescriptor } from './kernelContract'
import { assertValidKernelDescriptor } from './kernelContract'
import { SimulationKernelError } from './errors'
import type { KernelIdentity } from './types'

type RegisteredKernel = Readonly<{
  descriptor: KernelDescriptor
  prepare: unknown
  execute: unknown
}>

export class KernelRegistry {
  private readonly definitions = new Map<string, Map<string, RegisteredKernel>>()

  constructor(definitions: readonly RegisteredKernel[]) {
    definitions.forEach((definition) => {
      assertValidKernelDescriptor(definition.descriptor)
      if (typeof definition.prepare !== 'function' || typeof definition.execute !== 'function') {
        throw new Error('Kernel definitions require prepare and execute functions.')
      }
      const { name, version } = definition.descriptor
      const versions = this.definitions.get(name) ?? new Map<string, RegisteredKernel>()
      if (versions.has(version)) {
        throw new Error(`Kernel ${name}@${version} is registered more than once.`)
      }
      versions.set(version, definition)
      this.definitions.set(name, versions)
    })
  }

  get(identity: KernelIdentity) {
    return this.definitions.get(identity.name)?.get(identity.version) as unknown as KernelDefinition | undefined
  }

  require(identity: KernelIdentity) {
    const definition = this.get(identity)
    if (definition) return definition
    throw new SimulationKernelError(
      'backend',
      identity,
      `No kernel is registered for ${identity.name}@${identity.version}.`,
    )
  }

  identities() {
    return Object.freeze(
      [...this.definitions.entries()].flatMap(([name, versions]) =>
        [...versions.keys()].map((version) => Object.freeze({ name, version })),
      ),
    )
  }
}
