import { createUcumService } from '@fhir-toolkit/ucum'

export type UcumUnit = string

const dimensionlessUnit = '1'
const ucum = createUcumService()

export function normalizeUcumUnit(value: unknown, _path: string): UcumUnit {
  return value as UcumUnit
}

export function convertUcumValue(
  value: number,
  fromUnit: UcumUnit | undefined,
  toUnit: UcumUnit | undefined,
  _path = 'Unit conversion',
) {
  const from = fromUnit ?? dimensionlessUnit
  const to = toUnit ?? dimensionlessUnit
  return ucum.convert(value, from, to)
}
