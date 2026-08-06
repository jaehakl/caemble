import type { KernelIdentity } from './types'

export type SimulationKernelErrorKind = 'input' | 'convergence' | 'backend' | 'resource'

export class SimulationKernelError extends Error {
  readonly kind: SimulationKernelErrorKind
  readonly kernel: KernelIdentity

  constructor(kind: SimulationKernelErrorKind, kernel: KernelIdentity, message: string) {
    super(message)
    this.name = 'SimulationKernelError'
    this.kind = kind
    this.kernel = Object.freeze({
      name: kernel.name,
      version: kernel.version,
    })
  }
}

export class SimulationFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimulationFatalError'
  }
}
