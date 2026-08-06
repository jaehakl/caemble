import { cadElementDefinitions } from '../elements/generated'
import type { CadElementDefinition } from './types'

export { cadElementDefinitions }

export type CadElementTag = (typeof cadElementDefinitions)[number]['tag']

export function createCadElementRegistry(definitions: readonly CadElementDefinition[]) {
  const registry = new Map<string, CadElementDefinition>()
  definitions.forEach((definition) => {
    if (registry.has(definition.tag)) throw new Error(`Duplicate CAD element tag: ${definition.tag}`)
    if (definition.manifest.tag !== definition.tag) {
      throw new Error(`CAD element definition and manifest tags differ: ${definition.tag} / ${definition.manifest.tag}`)
    }
    registry.set(definition.tag, definition)
  })
  return registry
}

export const cadElementRegistry = createCadElementRegistry(cadElementDefinitions)

export function getCadElementDefinition(tag: string) {
  return cadElementRegistry.get(tag)
}
