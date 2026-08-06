export type Tensor = number | readonly Tensor[]
export type Vars = Record<string, Tensor>
export type Vec3 = readonly [number, number, number]
export type Rotation = Readonly<{
  axis: Vec3
  angle: number
}>
