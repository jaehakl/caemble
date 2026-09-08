import type { MaterialDefinition } from '@/contracts/material'
import { CadModelError } from './errors'
import { normalizeMaterialModels } from './materialNormalization'

export class Material {
  readonly name: string
  readonly color?: string
  readonly models: MaterialDefinition['models']

  constructor(name: string, options: Partial<MaterialDefinition> = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new CadModelError('Material name must be a non-empty string.')
    if (!options || typeof options !== 'object' || Array.isArray(options) || arguments.length > 2) {
      throw new CadModelError(`Material ${name} requires { color?, models? }; external Material selectors are not supported.`)
    }
    for (const key of Object.keys(options)) {
      if (key !== 'color' && key !== 'models') throw new CadModelError(`Material ${name}.${key} is not allowed; define physical parameters inside models.`)
    }
    if (options.color !== undefined && (typeof options.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(options.color))) {
      throw new CadModelError(`Material ${name}.color must use #RRGGBB format.`)
    }
    this.name = name.trim()
    if (options.color !== undefined) this.color = options.color
    this.models = normalizeMaterialModels(options.models ?? {}, `Material ${this.name}.models`)
    Object.freeze(this)
  }
}
