import 'mathjs'
import type { FactoryFunctionMap } from 'mathjs'

declare module 'mathjs' {
  export const combinationsWithRepDependencies: FactoryFunctionMap
  export const lsolveAllDependencies: FactoryFunctionMap
  export const solveODEDependencies: FactoryFunctionMap
  export const usolveAllDependencies: FactoryFunctionMap
}
