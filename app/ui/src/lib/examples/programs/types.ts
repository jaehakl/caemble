export type CaembleProgramExample = Readonly<{
  id: string
  title: string
  description: string
  concepts: readonly string[]
  structureCode: string
  experimentCode: string
  simulationCode: string
  verification: Readonly<{
    kernelTasks: readonly string[]
    recordedData: readonly string[]
    expectations: readonly string[]
  }>
}>
