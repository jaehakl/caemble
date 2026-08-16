import type { MaterialModelKey, MaterialPropertyKey } from '../../material/data'
import { getRuntimeMaterialModel, getRuntimeMaterialParameter } from '../../catalog/runtime'
import type { MaterialVariables, NormalizedMaterialVariables } from './descriptor'
import { CadModelError } from './errors'
import {
  isPlainObject,
  normalizeMaterialDataValueDescriptor,
  normalizeMaterialErrorRate,
  normalizeMaterialSampledRelation,
} from './core'

export class Material {
  readonly name: string
  readonly source?: string
  readonly version?: string
  readonly errorRate: number
  readonly variables: NormalizedMaterialVariables

  constructor(name: string)
  constructor(name: string, variables: MaterialVariables)
  constructor(name: string, sourceVersion: string)
  constructor(name: string, sourceVersion: string, variables: MaterialVariables)
  constructor(
    name: string,
    sourceVersionOrVariables?: string | MaterialVariables,
    sourceVersionVariables?: MaterialVariables,
  ) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new CadModelError('Material name must be a non-empty string.')
    }
    if (typeof sourceVersionOrVariables !== 'string' && arguments.length === 3) {
      throw new CadModelError('Material variables must follow a source selector when a third argument is supplied.')
    }
    let source: string | undefined
    let version: string | undefined
    if (typeof sourceVersionOrVariables === 'string') {
      const selector = sourceVersionOrVariables.trim()
      const segments = selector.split('/')
      if (!selector || segments.length > 2 || segments.some((segment) => !segment.trim())) {
        throw new CadModelError(`Material ${name} source selector must be "source" or "source/version".`)
      }
      source = segments[0].trim()
      if (segments.length === 2) version = segments[1].trim()
    }
    const rawVariables =
      typeof sourceVersionOrVariables === 'string'
        ? sourceVersionVariables === undefined
          ? {}
          : sourceVersionVariables
        : sourceVersionOrVariables === undefined
          ? {}
          : sourceVersionOrVariables
    if (!isPlainObject(rawVariables)) {
      throw new CadModelError(`Material ${name} variables must be a plain object.`)
    }
    const errorRate = normalizeMaterialErrorRate(rawVariables.errorRate, `Material ${name} variables.errorRate`)
    const normalizedVariables: Record<string, unknown> = {}
    Object.entries(rawVariables).forEach(([key, value]) => {
      if (!key.trim()) throw new CadModelError(`Material ${name} variable names must not be empty.`)
      const path = `Material ${name} variables.${key}`
      if (key === 'color') {
        normalizedVariables.color = value
      } else if (key === 'errorRate') {
        return
      } else if (getRuntimeMaterialParameter(key)) {
        if (!isPlainObject(value)) throw new CadModelError(`${path} must be a Material property descriptor.`)
        normalizedVariables[key] = normalizeMaterialDataValueDescriptor(
          key as MaterialPropertyKey,
          value,
          path,
          errorRate,
        )
      } else if (getRuntimeMaterialModel(key)) {
        if (!isPlainObject(value)) throw new CadModelError(`${path} must be a sampled relation.`)
        normalizedVariables[key] = normalizeMaterialSampledRelation(key as MaterialModelKey, value, path)
      } else {
        throw new CadModelError(`${path} is not a registered Material catalog key.`)
      }
    })
    if (normalizedVariables.color !== undefined) {
      if (typeof normalizedVariables.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(normalizedVariables.color)) {
        throw new CadModelError(`Material ${name} variables.color must use #RRGGBB format.`)
      }
      normalizedVariables.color = normalizedVariables.color.toLowerCase()
    }
    this.name = name.trim()
    if (source !== undefined) this.source = source
    if (version !== undefined) this.version = version
    this.errorRate = errorRate
    this.variables = Object.freeze(normalizedVariables) as NormalizedMaterialVariables
  }
}
