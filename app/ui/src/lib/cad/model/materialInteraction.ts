import type { MaterialInteractionDefinition } from '@/contracts/material'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { Material } from './material'
import { CadModelError } from './errors'
import { normalizeMaterialModels } from './materialNormalization'
import type { Vars } from './types'

export type MaterialInteractionOptions = Readonly<{
  between: readonly [Material, Material]
  models?: MaterialInteractionDefinition['models']
}>

/** An exported declaration, evaluated once with each Candidate's variables. */
export class MaterialInteraction<V extends Vars = Vars> {
  readonly name: string
  private readonly definition:
    MaterialInteractionOptions | ((context: Readonly<{ vars: Readonly<Vars> }>) => MaterialInteractionOptions)

  constructor(
    name: string,
    definition: MaterialInteractionOptions | ((context: Readonly<{ vars: Readonly<V> }>) => MaterialInteractionOptions),
  ) {
    if (typeof name !== 'string' || !name.trim())
      throw new CadModelError('MaterialInteraction requires a non-empty name.')
    this.name = name.trim()
    if (typeof definition !== 'function' && (!definition || !Array.isArray(definition.between)))
      throw new CadModelError('MaterialInteraction requires { between, models? } or a definition callback.')
    this.definition =
      typeof definition === 'function'
        ? ({ vars }) => definition({ vars: vars as Readonly<V> })
        : Object.freeze({
            ...definition,
            between: Object.freeze([...definition.between]) as readonly [Material, Material],
            models: definition.models === undefined ? undefined : structuredClone(definition.models),
          })
    Object.freeze(this)
  }

  evaluate(vars: Readonly<Vars>, catalog?: CatalogRuntimeSlice) {
    const options = typeof this.definition === 'function' ? this.definition({ vars }) : this.definition
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !['between', 'models'].includes(key))
    )
      throw new CadModelError(`MaterialInteraction ${this.name} requires { between, models? }.`)
    if (
      !Array.isArray(options.between) ||
      options.between.length !== 2 ||
      options.between.some((material) => !(material instanceof Material))
    )
      throw new CadModelError(`MaterialInteraction ${this.name}.between requires two Material instances.`)
    return Object.freeze({
      name: this.name,
      endpoints: Object.freeze([...options.between]) as readonly [Material, Material],
      between: Object.freeze(options.between.map((material) => material.name)) as readonly [string, string],
      models: normalizeMaterialModels(
        options.models ?? {},
        `MaterialInteraction ${this.name}.models`,
        catalog,
        'material-pair',
      ),
    })
  }
}
