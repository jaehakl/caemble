export type MaterialPropertyValue = Readonly<{
  dtype: 'float16' | 'float32' | 'float64'
  value: number | readonly unknown[]
  unit: string
  axes?: readonly [
    Readonly<{
      length: number
      name: 'frequency'
      ticks: readonly number[]
      unit: 'Hz'
      quantityKind: 'Frequency'
    }>,
  ]
}>

export type MaterialRelationValue = Readonly<{
  kind: 'sampled_relation'
  input: Readonly<{ unit: string; values: readonly unknown[] }>
  output: Readonly<{ unit: string; values: readonly unknown[] }>
}>

export type FrozenMaterialParameter = Readonly<{
  origin: 'database' | 'source'
  value: MaterialPropertyValue | MaterialRelationValue
  source: string | null
  version: string | null
  materialId: number | null
  materialParameterId: number | null
}>

export type FrozenMaterialParameters = Readonly<{
  materials: Readonly<Record<string, Readonly<Record<string, FrozenMaterialParameter>>>>
  materialColors?: Readonly<Record<string, Readonly<{ color: string; materialId: number }>>>
}>
