import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { InteractionSnapshot, TaskInteractionSelections } from '@/contracts/material'
import type { KernelDescriptor } from '@/contracts/solver'
import type { CadScene } from '../cad/evaluation/types'
import { CadModelError } from '../cad/model/errors'
import { normalizeMaterialModels, normalizeModelParameters } from '../cad/model/materialNormalization'
import { taskTargetParts } from './selection'

export function normalizeInteractions(input: InteractionSnapshot, catalog: CatalogRuntimeSlice): InteractionSnapshot {
  const pairs = new Set<string>()
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (
        !name.trim() ||
        name !== name.trim() ||
        !value ||
        Object.keys(value).some((key) => !['between', 'models'].includes(key)) ||
        !Array.isArray(value.between) ||
        value.between.length !== 2 ||
        value.between.some(
          (endpoint) => typeof endpoint !== 'string' || !endpoint.trim() || endpoint !== endpoint.trim(),
        )
      )
        throw new CadModelError(`MaterialInteraction ${name} requires two Material names and models.`)
      const pair = JSON.stringify([...value.between].sort())
      if (pairs.has(pair)) throw new CadModelError(`MaterialInteraction pair ${pair} is duplicated.`)
      pairs.add(pair)
      return [
        name,
        {
          between: value.between,
          models: normalizeMaterialModels(value.models, `interactions.${name}.models`, catalog, 'material-pair'),
        },
      ]
    }),
  )
}

export function selectTaskInteractionModels(
  descriptor: KernelDescriptor,
  config: Readonly<Record<string, unknown>>,
  scenes: Readonly<{ experiment: CadScene; task: CadScene }>,
  interactions: InteractionSnapshot,
  catalog: CatalogRuntimeSlice,
  path: string,
): TaskInteractionSelections {
  const explicit = config.interactionModels ?? {}
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit))
    throw new CadModelError(`${path}.interactionModels must be an object.`)
  const requested = explicit as Record<string, Record<string, Record<string, string>>>
  const consumed = new Set<string>()
  const result: Record<string, TaskInteractionSelections[string]> = {}
  for (const role of descriptor.interactions ?? []) {
    for (const group of role.modelGroups) {
      const fallback = group.defaultModel
      if (!fallback) continue
      const definition = catalog.materialModels.find((model) => model.key === fallback.model)
      if (group.required || !group.oneOf.includes(fallback.model) || definition?.subject?.kind !== 'material-pair')
        throw new CadModelError(`${path}.${role.role}.${group.key}: invalid default Interaction model.`)
      normalizeModelParameters(
        definition.parameterSchema,
        fallback.parameters,
        `${path}.${role.role}.${group.key}.defaultModel`,
        catalog,
      )
    }
    const parts = taskTargetParts(role.target, config, scenes, path)
    if (parts.some((part) => !part.material))
      throw new CadModelError(`${path}.${role.role}: contact targets require Materials.`)
    const names = [...new Set(parts.map((part) => part.material!.name))].sort()
    result[role.role] = names.flatMap((first, i) =>
      names.slice(i).map((second) => {
        const match = Object.entries(interactions).find(
          ([, item]) => JSON.stringify([...item.between].sort()) === JSON.stringify([first, second]),
        )
        const models: Record<string, string | null> = {}
        for (const group of role.modelGroups) {
          const candidates = match
            ? Object.entries(match[1].models).filter(([, model]) => group.oneOf.includes(model.model))
            : []
          const choice = match ? requested[role.role]?.[match[0]]?.[group.key] : undefined
          if (choice !== undefined) {
            if (!candidates.some(([name]) => name === choice))
              throw new CadModelError(
                `${path}.interactionModels.${role.role}.${match![0]}.${group.key}: unsupported model selection.`,
              )
            consumed.add(JSON.stringify([role.role, match![0], group.key]))
          } else if (candidates.length > 1) {
            throw new CadModelError(
              `${path}.interactionModels.${role.role}.${match![0]}.${group.key}: multiple models require an explicit selection.`,
            )
          }
          const selected = choice ?? candidates[0]?.[0] ?? null
          if (selected === null && (group.required || !group.defaultBehavior))
            throw new CadModelError(
              `${path}.${role.role}.${first}/${second}.${group.key}: a supported Interaction model is required.`,
            )
          models[group.key] = selected
        }
        // Ordered models retain the authored endpoint orientation in the frozen binding.
        const ordered =
          match &&
          Object.values(models).some((instance) => {
            if (instance === null) return false
            const subject = catalog.materialModels.find(
              (model) => model.key === match[1].models[instance].model,
            )?.subject
            return subject?.kind === 'material-pair' && subject.exchange === 'ordered'
          })
        return {
          between: ordered ? match![1].between : ([first, second] as const),
          interaction: match?.[0] ?? null,
          models,
        }
      }),
    )
  }
  for (const [role, values] of Object.entries(requested)) {
    if (!(role in result)) throw new CadModelError(`${path}.interactionModels.${role} does not apply to this Task.`)
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new CadModelError(`${path}.interactionModels.${role} must be an object.`)
    for (const [name, groups] of Object.entries(values)) {
      if (!result[role].some((binding) => binding.interaction === name))
        throw new CadModelError(`${path}.interactionModels.${role}.${name} does not apply to this Task.`)
      if (!groups || typeof groups !== 'object' || Array.isArray(groups))
        throw new CadModelError(`${path}.interactionModels.${role}.${name} must be an object.`)
      for (const group of Object.keys(groups))
        if (!consumed.has(JSON.stringify([role, name, group])))
          throw new CadModelError(`${path}.interactionModels.${role}.${name}.${group} does not apply to this Task.`)
    }
  }
  return result
}
