import { z } from 'zod'
import { analyzeCalculationDependencies } from './dependencies'
import { CalculationExecutionError, calculationDtypes, calculationInputDtypes } from './types'

const axisSchema = z.object({ name: z.string().min(1).optional(), unit: z.string().min(1).optional() }).strict()
const tensorFields = {
  dtype: z.enum(calculationDtypes),
  shape: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()),
  axes: z.array(axisSchema).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}
const tensorSchema = z.object(tensorFields).strict()
export type DeclaredTensorContract = z.infer<typeof tensorSchema> & {
  unit?: string
  quantityKind?: string
  tensorOrder?: number
}
function validTensor(value: DeclaredTensorContract) {
  return (
    (!value.axes || value.axes.length === value.shape.length) &&
    (value.min === undefined || value.max === undefined || value.min <= value.max)
  )
}
export const calculationContractSchema = z
  .object({
    version: z.literal(1),
    inputs: z.record(
      z
        .string()
        .min(1)
        .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name)),
      tensorSchema
        .extend({
          dtype: z.enum(calculationInputDtypes),
          shape: tensorFields.shape.length(7),
          unit: z.string().min(1).optional(),
          quantityKind: z.string().min(1).optional(),
          tensorOrder: z.number().int().min(0).max(2).optional(),
        })
        .strict()
        .refine(validTensor, 'Invalid axes or bounds'),
    ),
    output: tensorSchema
      .extend({ shape: tensorFields.shape.max(3) })
      .strict()
      .refine(validTensor, 'Invalid axes or bounds'),
  })
  .strict()
export type DeclaredCalculationContract = z.infer<typeof calculationContractSchema>

export function extractCalculationContract(source: string): DeclaredCalculationContract | null {
  if (!source.includes('@caemble-contract')) return null
  try {
    const match = /^\s*\/\* @caemble-contract\s+([\s\S]*?)\*\//u.exec(source)
    if (!match || source.split('@caemble-contract').length !== 2)
      throw new Error('Use one leading /* @caemble-contract { JSON } */ declaration.')
    const contract = calculationContractSchema.parse(JSON.parse(match[1]))
    const dependencies = analyzeCalculationDependencies(source)
    if (JSON.stringify([...dependencies].sort()) !== JSON.stringify(Object.keys(contract.inputs).sort()))
      throw new Error('Declared input names must match Calculation Record dependencies.')
    return contract
  } catch (error) {
    throw new CalculationExecutionError(
      'policy',
      error instanceof Error ? error.message : 'Invalid Calculation contract',
    )
  }
}

export function assertDeclaredTensor(
  contract: DeclaredTensorContract,
  tensor: {
    dtype: string
    shape: readonly number[]
    axes: readonly { name: string; unit?: string }[]
    data: number | readonly number[]
    unit?: string
    quantityKind?: string
    tensorOrder?: number
  },
) {
  if (
    tensor.dtype !== contract.dtype ||
    tensor.shape.length !== contract.shape.length ||
    contract.shape.some((size, index) => size !== null && size !== tensor.shape[index])
  )
    throw new CalculationExecutionError(
      'runtime',
      'Tensor dtype/shape does not match the declared Calculation contract.',
    )
  for (const key of ['unit', 'quantityKind', 'tensorOrder'] as const) {
    if (contract[key] !== undefined && contract[key] !== tensor[key])
      throw new CalculationExecutionError('runtime', `Tensor ${key} does not match the declared Calculation contract.`)
  }
  contract.axes?.forEach((axis, index) => {
    if (Object.entries(axis).some(([key, value]) => tensor.axes[index]?.[key as 'name' | 'unit'] !== value))
      throw new CalculationExecutionError('runtime', 'Tensor axes do not match the declared Calculation contract.')
  })
  const values = typeof tensor.data === 'number' ? [tensor.data] : tensor.data
  if (values.some((value) => value < (contract.min ?? -Infinity) || value > (contract.max ?? Infinity)))
    throw new CalculationExecutionError('runtime', 'Tensor data violates the declared Calculation bounds.')
}
