import type { OptimizationAxis, OptimizationTensor } from '@/contracts/api/optimization'
import { flattenVarsTensor, type Vars } from '@caemble/execution/cad/model'
import type { VarsSchema } from '@caemble/execution/cad/model/vars'

function validateOptimizationSchema(schema: VarsSchema) {
  for (const [name, entry] of Object.entries(schema)) {
    if (
      !Array.isArray(entry.shape) ||
      entry.shape.length > 2 ||
      entry.shape.some((length) => !Number.isSafeInteger(length) || length < 1) ||
      !Number.isSafeInteger(entry.shape.reduce((total, length) => total * length, 1))
    )
      throw new Error(`${name}: Vars의 shape는 양의 정수로 이루어진 최대 2차원 배열이어야 합니다.`)
    if (!Number.isFinite(entry.min) || !Number.isFinite(entry.max) || entry.min > entry.max)
      throw new Error(`${name}: Vars에 유효한 상·하한을 정의하세요.`)
  }
}

export function optimizationAxes(schema: VarsSchema): OptimizationAxis[] {
  validateOptimizationSchema(schema)
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
  validateOptimizationSchema(schema)
  if (Object.keys(vars).length !== Object.keys(schema).length)
    throw new Error('Candidate와 Vars 정의가 일치하지 않습니다.')
  for (const [name, entry] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error('Candidate와 Vars 정의가 일치하지 않습니다.')
    const values = flattenVarsTensor(vars[name], entry.shape, name)
    if (values.length !== entry.shape.reduce((total, length) => total * length, 1))
      throw new Error(`${name}: 모든 변수 원소에 유효한 값을 입력하세요.`)
    if (values.some((value) => value < entry.min || value > entry.max))
      throw new Error(`${name} 값이 허용 범위를 벗어났습니다.`)
  }
  return JSON.parse(JSON.stringify(vars)) as Record<string, OptimizationTensor>
}

export function validateOptimizationAxes(axes: readonly OptimizationAxis[], vars: Readonly<Vars>, schema: VarsSchema) {
  validateOptimizationSchema(schema)
  const configured = new Set<string>()
  for (const axis of axes) {
    const entry = schema[axis.name]
    const label = `${axis.name}${axis.indices.map((index) => `[${index}]`).join('')}`
    if (
      !Object.prototype.hasOwnProperty.call(schema, axis.name) ||
      axis.indices.length !== entry.shape.length ||
      axis.indices.some(
        (index, dimension) => !Number.isSafeInteger(index) || index < 0 || index >= entry.shape[dimension],
      )
    )
      throw new Error(`${label}: 현재 Vars에 존재하는 변수 원소를 선택하세요.`)
    const key = JSON.stringify([axis.name, axis.indices])
    if (configured.has(key)) throw new Error(`${label}: 같은 변수 원소의 탐색 범위가 중복되었습니다.`)
    configured.add(key)
    let value: unknown = vars[axis.name]
    for (const index of axis.indices) value = Array.isArray(value) ? value[index] : undefined
    if (
      !Number.isFinite(axis.min) ||
      !Number.isFinite(axis.max) ||
      axis.min > axis.max ||
      axis.min < entry.min ||
      axis.max > entry.max ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < axis.min ||
      value > axis.max
    )
      throw new Error(`${label}: 현재 값이 포함된 유효한 탐색 범위를 입력하세요.`)
  }
}
