export type ExperimentSourceBundle = Readonly<{
  files: Readonly<Record<string, string>>
}>

export type RecordedDataAxis = Readonly<{
  ticks?: readonly (number | string)[]
  implicitOrdinal?: true
}>

export type PersistedDataTensor = Readonly<{
  shape: readonly number[]
  axes?: readonly RecordedDataAxis[]
  storage: Readonly<{ kind: 'inline'; value: unknown }> | Readonly<{ kind: 'base64'; data: string; byteLength: number }>
}>
