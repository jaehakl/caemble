export type ModelQuantityValue = Readonly<{
  dtype: 'float16' | 'float32' | 'float64'
  value: number | readonly unknown[]
  unit: string
  basis?: readonly (readonly number[])[]
}>

export type MaterialModelInstance = Readonly<{
  model: string
  parameters: Readonly<Record<string, unknown>>
}>

export type MaterialDefinition = Readonly<{
  color?: string
  models: Readonly<Record<string, MaterialModelInstance>>
}>

/** Experiment-owned physical inputs. Numerical methods belong to the Task. */
export type MaterialSnapshot = Readonly<{
  materials: Readonly<Record<string, MaterialDefinition>>
}>

export type TaskMaterialSelections = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
>
