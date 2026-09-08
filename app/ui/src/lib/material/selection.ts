import type { KernelDescriptor } from '@/contracts/solver'
import type { TaskMaterialSelections } from '@/contracts/material'
import type { CadScene, CadScenePart } from '../cad/evaluation/types'
import { CadModelError } from '../cad/model/errors'

export function selectTaskMaterialModels(
  descriptor: KernelDescriptor,
  config: Readonly<Record<string, unknown>>,
  scenes: Readonly<{ experiment: CadScene; task: CadScene }>,
  path: string,
): TaskMaterialSelections {
  const explicit = config.materialModels ?? {}
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit))
    throw new CadModelError(`${path}.materialModels must be an object.`)
  const selections: Record<string, Record<string, Record<string, string>>> = Object.create(null)
  const consumed = new Set<string>()
  for (const role of descriptor.materials) {
    const parts: CadScenePart[] = []
    if (role.target.category === 'geometry') {
      parts.push(...scenes[role.target.source].parts)
    } else {
      const calls = config[role.target.category]
      if (Array.isArray(calls))
        for (const [callIndex, call] of calls.entries()) {
          if (call?.methodId !== role.target.methodId) continue
          const targetPath = `${path}.${role.target.category}[${callIndex}].target`
          if (!Array.isArray(call.target)) throw new CadModelError(`${targetPath} must be a target list.`)
          for (const [targetIndex, target] of call.target.entries()) {
            if (typeof target !== 'string')
              throw new CadModelError(`${targetPath}[${targetIndex}] must name a target group.`)
            const match = /^(experiment|task)\.(geometry|surface)\.(.+)$/u.exec(target)
            if (!match) throw new CadModelError(`${targetPath}[${targetIndex}]: invalid Material target ${target}.`)
            const scene = scenes[match[1] as 'experiment' | 'task']
            const group = (match[2] === 'geometry' ? scene.geometryGroups : scene.surfaceGroups).find(
              (item) => item.name === match[3],
            )
            if (!group)
              throw new CadModelError(`${targetPath}[${targetIndex}]: Material target ${target} does not exist.`)
            parts.push(
              ...scene.parts.filter((part) =>
                match[2] === 'geometry'
                  ? group.geometryIds.includes(part.id)
                  : part.surfaces.some((surface) => group.surfaceIds.includes(surface.id)),
              ),
            )
          }
        }
    }
    for (const part of parts) {
      if (!part.material && role.modelGroups.some((group) => group.required))
        throw new CadModelError(
          `${path}.materialModels.${role.role}: geometry[${JSON.stringify(part.id)}] requires a Material.`,
        )
    }
    const materials = new Map(
      parts.filter((part) => part.material).map((part) => [part.material!.name, part.material!]),
    )
    for (const [name, material] of materials) {
      for (const group of role.modelGroups) {
        const selectionPath = `${path}.materialModels.${role.role}.${name}.${group.key}`
        const requested = (explicit as TaskMaterialSelections)[role.role]?.[name]?.[group.key]
        const candidates = Object.entries(material.models)
          .filter(([, instance]) => group.oneOf.includes(instance.model))
          .map(([instance]) => instance)
        let selected: string | undefined
        if (requested !== undefined) {
          if (typeof requested !== 'string' || !candidates.includes(requested))
            throw new CadModelError(
              `${selectionPath} must select a compatible model instance (${candidates.join(', ')}).`,
            )
          selected = requested
          consumed.add(JSON.stringify([role.role, name, group.key]))
        } else if (candidates.length > 1) {
          throw new CadModelError(
            `${selectionPath} is ambiguous (${candidates.join(', ')}); select an instance explicitly.`,
          )
        } else if (candidates.length === 1) {
          selected = candidates[0]
        } else if (group.required) {
          throw new CadModelError(`${selectionPath} requires one of ${group.oneOf.join(', ')}.`)
        }
        if (selected !== undefined) {
          selections[role.role] ??= Object.create(null)
          selections[role.role][name] ??= Object.create(null)
          selections[role.role][name][group.key] = selected
        }
      }
    }
  }
  for (const [role, materials] of Object.entries(explicit)) {
    if (!materials || typeof materials !== 'object' || Array.isArray(materials))
      throw new CadModelError(`${path}.materialModels.${role} must be an object.`)
    for (const [name, groups] of Object.entries(materials)) {
      if (!groups || typeof groups !== 'object' || Array.isArray(groups))
        throw new CadModelError(`${path}.materialModels.${role}.${name} must be an object.`)
      for (const group of Object.keys(groups)) {
        if (!consumed.has(JSON.stringify([role, name, group])))
          throw new CadModelError(
            `${path}.materialModels.${role}.${name}.${group} does not address an applicable model group.`,
          )
      }
    }
  }
  return selections
}
