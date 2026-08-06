import { CadModelError } from '../../../cad/model/core'
import { SimulationKernelError } from '../../errors'
import type { KernelExecutionContext, KernelExecutionInput, KernelExecutionResult } from '../../kernelContract'
import { steadyStateHeatDescriptor } from './descriptor'
import { solvePreparedSteadyStateHeat } from './numeric'
import type { PreparedSteadyStateHeatInput } from './prepare'

export async function executeSteadyStateHeat(
  input: KernelExecutionInput<PreparedSteadyStateHeatInput>,
  context: KernelExecutionContext,
): Promise<KernelExecutionResult> {
  try {
    return await solvePreparedSteadyStateHeat(input.prepared, input.inputs, context)
  } catch (error) {
    if (error instanceof SimulationKernelError) throw error
    const message = error instanceof Error ? error.message : String(error)
    const kind =
      context.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? 'resource'
        : /converg/i.test(message)
          ? 'convergence'
          : error instanceof CadModelError
            ? 'input'
            : error instanceof RangeError
              ? 'resource'
              : 'backend'
    throw new SimulationKernelError(kind, steadyStateHeatDescriptor, message)
  }
}
