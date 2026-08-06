import { createUcumService } from '@fhir-toolkit/ucum'
import { CadModelError } from './errors'

export type UcumUnit = string

const dimensionlessUnit = '1'
const ucum = createUcumService()

export function normalizeUcumUnit(value: unknown, path: string): UcumUnit {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new CadModelError(`${path} must be a non-empty UCUM code without surrounding whitespace.`)
  }

  try {
    ucum.validate(value)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new CadModelError(`${path} must be a valid case-sensitive UCUM code.${detail}`)
  }
  return value
}

export function convertUcumValue(
  value: number,
  fromUnit: UcumUnit | undefined,
  toUnit: UcumUnit | undefined,
  path = 'Unit conversion',
) {
  if (!Number.isFinite(value)) throw new CadModelError(`${path} value must be finite.`)
  const from = fromUnit === undefined ? dimensionlessUnit : normalizeUcumUnit(fromUnit, `${path} source unit`)
  const to = toUnit === undefined ? dimensionlessUnit : normalizeUcumUnit(toUnit, `${path} target unit`)

  try {
    const converted = ucum.convert(value, from, to)
    if (!Number.isFinite(converted)) throw new Error('conversion returned a non-finite value')
    return converted
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new CadModelError(`${path} cannot convert ${from} to ${to}.${detail}`)
  }
}

export function assertUcumUnitComparable(unit: UcumUnit | undefined, expectedUnit: UcumUnit | undefined, path: string) {
  convertUcumValue(1, unit, expectedUnit, path)
}
