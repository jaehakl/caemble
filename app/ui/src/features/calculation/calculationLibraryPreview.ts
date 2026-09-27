import type { CalculationLibraryDetail } from '@/api/calculationLibrary'
import { analyzeCalculationDependencies } from '@/lib/calculation'

export function calculationLibraryInputs(detail: CalculationLibraryDetail) {
  try {
    const names = analyzeCalculationDependencies(detail.source_code)
    return {
      error: null,
      items: names.map((name) => ({ name, contract: detail.inputs.find((input) => input.name === name) ?? null })),
    }
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause.message : String(cause),
      items: detail.inputs_verified ? detail.inputs.map((contract) => ({ name: contract.name, contract })) : [],
    }
  }
}

export function libraryInputShape(schema: Readonly<Record<string, unknown>> | null | undefined): string {
  if (Array.isArray(schema?.shape)) {
    return `[${schema.shape.map((length) => (Number.isSafeInteger(length) && Number(length) >= 0 ? String(length) : '?')).join(', ')}]`
  }
  if (!Array.isArray(schema?.axes)) return '동적·미확인'
  return `[${schema.axes
    .map((axis: unknown) => {
      if (!axis || typeof axis !== 'object') return '?'
      const value = axis as Record<string, unknown>
      if (Number.isSafeInteger(value.length) && Number(value.length) >= 0) return String(value.length)
      return Array.isArray(value.ticks) ? String(value.ticks.length) : '?'
    })
    .join(', ')}]`
}
