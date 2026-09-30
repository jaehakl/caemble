import type { OptimizationAxis, OptimizationTensor } from '@/contracts/api/optimization'
import { flattenVarsTensor, type Vars } from '@/lib/cad/model'
import type { VarsSchema } from '@/lib/cad/model/vars'

export function optimizationAxes(schema: VarsSchema): OptimizationAxis[] {
  return Object.entries(schema).flatMap(([name, entry]) => {
    const size = entry.shape.reduce((total, length) => total * length, 1)
    return Array.from({ length: size }, (_, flatIndex) => {
      let remaining = flatIndex
      const indices = entry.shape.map(() => 0)
      for (let axis = entry.shape.length - 1; axis >= 0; axis--) {
        indices[axis] = remaining % entry.shape[axis]
        remaining = Math.floor(remaining / entry.shape[axis])
      }
      return { name, indices, min: entry.min, max: entry.max, fixed: entry.min === entry.max }
    })
  })
}

export function optimizationVariables(vars: Readonly<Vars>, schema: VarsSchema): Record<string, OptimizationTensor> {
  if (Object.keys(vars).length !== Object.keys(schema).length)
    throw new Error('Candidate와 Vars 정의가 일치하지 않습니다.')
  for (const [name, entry] of Object.entries(schema)) {
    const values = flattenVarsTensor(vars[name], entry.shape, name)
    if (values.some((value) => !Number.isFinite(value) || value < entry.min || value > entry.max))
      throw new Error(`${name} 값이 허용 범위를 벗어났습니다.`)
  }
  return JSON.parse(JSON.stringify(vars)) as Record<string, OptimizationTensor>
}

export function validateOptimizationAxes(axes: readonly OptimizationAxis[], vars: Readonly<Vars>, schema: VarsSchema) {
  for (const axis of axes) {
    const entry = schema[axis.name]
    let value: unknown = vars[axis.name]
    for (const index of axis.indices) value = (value as unknown[])[index]
    if (
      !Number.isFinite(axis.min) ||
      !Number.isFinite(axis.max) ||
      axis.min > axis.max ||
      axis.min < entry.min ||
      axis.max > entry.max ||
      typeof value !== 'number' ||
      value < axis.min ||
      value > axis.max
    )
      throw new Error(
        `${axis.name}${axis.indices.map((index) => `[${index}]`).join('')}: 현재 값이 포함된 유효한 탐색 범위를 입력하세요.`,
      )
  }
}
