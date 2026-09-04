import {
  flattenVarsTensor,
  tensorElementCount,
  varsTensorFromFlat,
  type Tensor,
  type Vars,
  type VarsSchemaEntry,
} from '@/lib/cad/model'

export function validateVarsTensor(value: Tensor, entry: VarsSchemaEntry, label = 'Candidate variable') {
  const flat = flattenVarsTensor(value, entry.shape, label)
  if (flat.length !== tensorElementCount(entry.shape)) {
    throw new Error(`${label} must have shape ${JSON.stringify(entry.shape)}.`)
  }
  flat.forEach((item) => {
    if (item < entry.min || item > entry.max) {
      throw new Error(`${label} values must be between ${entry.min} and ${entry.max}.`)
    }
  })
  return varsTensorFromFlat(flat, entry.shape)
}

export function validateVarsChanges(
  changes: Readonly<Vars>,
  schema: Readonly<Record<string, VarsSchemaEntry>>,
  label = 'Candidate vars',
) {
  const normalized: Vars = {}
  Object.entries(changes).forEach(([key, value]) => {
    const entry = schema[key]
    if (!entry) throw new Error(`${label}.${key} does not exist in varsSchema.`)
    normalized[key] = validateVarsTensor(value, entry, `${label}.${key}`)
  })
  return Object.freeze(normalized)
}

export function compatibleVarsResetValues(
  dataset: readonly Readonly<Vars>[],
  schema: Readonly<Record<string, VarsSchemaEntry>>,
): Readonly<Record<string, Tensor | undefined>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).map(([key, entry]) => {
        if (entry.min <= 0 && entry.max >= 0) {
          return [key, varsTensorFromFlat(Array(tensorElementCount(entry.shape)).fill(0), entry.shape)]
        }
        const compatible = dataset.flatMap((vars) => {
          const value = vars[key]
          if (value === undefined) return []
          try {
            const row = flattenVarsTensor(value, entry.shape, `vars.${key}`)
            return row.every((member) => member >= entry.min && member <= entry.max) ? [row] : []
          } catch {
            return []
          }
        })
        if (!compatible.length) return [key, undefined]
        const reset = Array.from({ length: compatible[0].length }, (_item, coordinate) => {
          const values = compatible.map((row) => row[coordinate]).sort((left, right) => left - right)
          const median =
            values.length % 2 === 1
              ? values[(values.length - 1) / 2]
              : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
          const counts = new Map<number, number>()
          values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
          return [...counts.entries()].sort(
            ([leftValue, leftCount], [rightValue, rightCount]) =>
              rightCount - leftCount ||
              Math.abs(leftValue - median) - Math.abs(rightValue - median) ||
              leftValue - rightValue,
          )[0][0]
        })
        return [key, varsTensorFromFlat(reset, entry.shape)]
      }),
    ),
  )
}
