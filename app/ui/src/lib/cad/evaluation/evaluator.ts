import { CadModelError, Material, resolveMaterialVariables } from '../model/core'
import { deriveGeometrySurfaces, validateSurfacePartition } from '../geometry/surfaces'
import { getCadElementDefinition } from './registry'
import { flattenValues, Fragment, isCadNode } from './jsx'
import { applyTransforms, normalizeTransforms } from './transforms'
import { applyCadSceneGroups, type CadSceneGroupOptions } from './groups'
import type { CadScene, CadSceneMaterial, CadScenePart, CadSceneTreeNode, EvaluatedPart } from './types'
import { assertUcumUnitComparable, normalizeUcumUnit, type UcumUnit } from '../model/units'

type EvaluationState = {
  nodes: Map<string, CadSceneTreeNode>
  localIdsByParent: Map<string, Set<string>>
  rootLabel: string
}

const localGeometryIdPattern = /^[\p{L}\p{N}_-]+$/u

function resolveMaterials(value: unknown, inherited: readonly Material[] | undefined) {
  if (value === undefined) return inherited === undefined ? undefined : [...inherited]
  if (!Array.isArray(value) || value.length === 0 || value.some((material) => !(material instanceof Material))) {
    throw new CadModelError('Geometry materials must be a non-empty array of Material instances.')
  }
  return [...value] as Material[]
}

function addTreeNode(state: EvaluationState, parent: CadSceneTreeNode, key: string, label: string, globalId?: string) {
  const node: CadSceneTreeNode = {
    key,
    label,
    ...(globalId === undefined ? {} : { globalId }),
    children: [],
  }
  state.nodes.set(key, node)
  parent.children.push(node)
  return node
}

function annotateGeometryNodes(tree: CadSceneTreeNode) {
  const geometryIdsByKey = new Map<string, string[]>()
  const collectGeometryIds = (node: CadSceneTreeNode): string[] => {
    const geometryIds = [...(node.geometryId ? [node.geometryId] : []), ...node.children.flatMap(collectGeometryIds)]
    geometryIdsByKey.set(node.key, geometryIds)
    return geometryIds
  }
  collectGeometryIds(tree)

  const pending = [tree]
  while (pending.length > 0) {
    const node = pending.shift()!
    const geometryIds = geometryIdsByKey.get(node.key) ?? []
    if (node.globalId && !node.geometryId && geometryIds.length > 0) {
      node.groupId = node.globalId
      node.geometryIds = geometryIds
    }
    pending.unshift(...node.children)
  }
}

function resolveGeometryId(value: unknown, label: string, parentId: string, state: EvaluationState) {
  if (typeof value !== 'string' || !localGeometryIdPattern.test(value)) {
    throw new CadModelError(
      `Geometry ${label} id must be a non-empty string containing only Unicode letters, numbers, "_", or "-".`,
    )
  }

  const siblingIds = state.localIdsByParent.get(parentId) ?? new Set<string>()
  if (siblingIds.has(value)) {
    throw new CadModelError(`Geometry id "${value}" must be unique within parent "${parentId || state.rootLabel}".`)
  }
  siblingIds.add(value)
  state.localIdsByParent.set(parentId, siblingIds)
  return parentId ? `${parentId}.${value}` : value
}

function evaluateNode(
  value: unknown,
  inheritedMaterials: readonly Material[] | undefined,
  state: EvaluationState,
  traceParent: CadSceneTreeNode,
  nodeKey: string,
  identityParent: string,
  ownerNodeKey: string | undefined,
): EvaluatedPart[] {
  if (Array.isArray(value)) {
    return flattenValues(value).flatMap((item, index) =>
      evaluateNode(
        item,
        inheritedMaterials,
        state,
        traceParent,
        `${nodeKey}/item-${index}`,
        identityParent,
        ownerNodeKey,
      ),
    )
  }
  if (!isCadNode(value)) throw new CadModelError('Geometry functions must return CAD JSX.')

  const { children, props, type } = value
  if (type === Fragment) {
    if (props.pos !== undefined || props.rotate !== undefined || props.scale !== undefined) {
      throw new CadModelError('Fragment does not accept pos, rotate, or scale. Use a Geometry or CAD element.')
    }
    return children.flatMap((child, index) =>
      evaluateNode(
        child,
        inheritedMaterials,
        state,
        traceParent,
        `${nodeKey}/fragment-${index}`,
        identityParent,
        ownerNodeKey,
      ),
    )
  }

  if (typeof type === 'function') {
    const label = type.name || 'Anonymous Geometry'
    const globalId = resolveGeometryId(props.id, label, identityParent, state)
    const traceNode = addTreeNode(state, traceParent, nodeKey, label, globalId)
    const owner = `Geometry ${type.name || '<anonymous>'}`
    const transformValues = normalizeTransforms(props, owner)
    const materials = resolveMaterials(props.materials, inheritedMaterials)
    const result = type({
      ...props,
      pos: transformValues.pos,
      rotate: transformValues.rotate,
      scale: transformValues.scale,
      materials,
      children,
    })
    return applyTransforms(
      evaluateNode(result, materials, state, traceNode, `${nodeKey}/result`, globalId, traceNode.key),
      transformValues,
    )
  }

  if (type === 'translate')
    throw new CadModelError('<translate> is not supported. Use the relative pos attribute instead.')
  if (type === 'rotate')
    throw new CadModelError('<rotate> is not supported. Use the axis-angle rotate attribute instead.')
  if (type === 'scale') throw new CadModelError('<scale> is not supported. Use the scale attribute instead.')

  const definition = getCadElementDefinition(type)
  if (!definition) throw new CadModelError(`Unknown CAD element: ${type}`)
  const traceNode = addTreeNode(state, traceParent, nodeKey, `<${type}>`)
  const transformValues = normalizeTransforms(props, `<${type}>`)
  let parts: EvaluatedPart[]

  if (definition.kind === 'primitive') {
    if (!ownerNodeKey) {
      throw new CadModelError('CAD geometry must be created within a Geometry component with an explicit id.')
    }
    const materials = resolveMaterials(undefined, inheritedMaterials)

    const geometry = definition.createGeometry(props)
    parts = [
      {
        geometry,
        ...(materials === undefined ? {} : { material: materials[0] }),
        surfaces: definition.createSurfaces(geometry, props),
        ownerNodeKey,
        resultNodeKey: nodeKey,
      },
    ]
  } else {
    let childIndex = 0
    parts = definition.evaluate(value, {
      inheritedMaterials,
      evaluate: (child, materials = inheritedMaterials, trace) => {
        if (trace) {
          const wrapperKey = `${nodeKey}/${trace.key}`
          const wrapper = addTreeNode(state, traceNode, wrapperKey, trace.label)
          const childIdentityParent = trace.identitySegment
            ? `${identityParent ? `${identityParent}.` : ''}${trace.identitySegment}`
            : identityParent
          return evaluateNode(
            child,
            materials,
            state,
            wrapper,
            `${wrapperKey}/value`,
            childIdentityParent,
            ownerNodeKey,
          )
        }

        const childKey = `${nodeKey}/child-${childIndex}`
        childIndex += 1
        return evaluateNode(child, materials, state, traceNode, childKey, identityParent, ownerNodeKey)
      },
    })

    if (definition.surfacePolicy === 'derive') {
      parts = parts.map((part) => {
        const derived = deriveGeometrySurfaces(part.geometry)
        return {
          ...part,
          geometry: derived.geometry,
          surfaces: derived.surfaces,
          ownerNodeKey,
          resultNodeKey: nodeKey,
        }
      })
    }
  }

  return applyTransforms(parts, transformValues)
}

export function evaluateCadScene(
  root: unknown,
  groupOptions: CadSceneGroupOptions = {},
  rootLabel = 'Structure',
  rawLengthUnit: UcumUnit = 'm',
): CadScene {
  const lengthUnit = normalizeUcumUnit(rawLengthUnit, `${rootLabel} scene lengthUnit`)
  assertUcumUnitComparable(lengthUnit, 'm', `${rootLabel} scene lengthUnit`)
  const rootKey = rootLabel.toLowerCase()
  const tree: CadSceneTreeNode = { key: rootKey, label: rootLabel, children: [] }
  const state: EvaluationState = {
    nodes: new Map([[tree.key, tree]]),
    localIdsByParent: new Map(),
    rootLabel,
  }
  const evaluatedParts = evaluateNode(root, undefined, state, tree, `${rootKey}/root`, '', undefined)
  if (evaluatedParts.length === 0) throw new CadModelError(`${rootLabel} geometry did not return any CAD geometry.`)

  const ownerIds = evaluatedParts.map((part) => {
    if (!part.ownerNodeKey) {
      throw new CadModelError('CAD geometry must be created within a Geometry component with an explicit id.')
    }
    const owner = state.nodes.get(part.ownerNodeKey)
    if (!owner?.globalId) throw new CadModelError('CAD evaluation lost a Geometry identity owner.')
    return owner.globalId
  })
  const subtreePartCounts = new Map<string, number>()
  ownerIds.forEach((ownerId) => {
    let ancestorId = ''
    ownerId.split('.').forEach((segment) => {
      ancestorId = ancestorId ? `${ancestorId}.${segment}` : segment
      subtreePartCounts.set(ancestorId, (subtreePartCounts.get(ancestorId) ?? 0) + 1)
    })
  })
  const directPartCounts = new Map<string, number>()
  const directPartOrdinals = evaluatedParts.map((part) => {
    const ordinal = (directPartCounts.get(part.ownerNodeKey!) ?? 0) + 1
    directPartCounts.set(part.ownerNodeKey!, ordinal)
    return ordinal
  })

  const sceneMaterials = new Map<Material, CadSceneMaterial>()
  const parts: CadScenePart[] = evaluatedParts.map((part, partIndex) => {
    if (!part.surfaces || !part.ownerNodeKey || !part.resultNodeKey) {
      throw new CadModelError('CAD evaluation produced geometry without surface metadata.')
    }
    validateSurfacePartition(part.geometry, part.surfaces)

    const owner = state.nodes.get(part.ownerNodeKey)
    const resultNode = state.nodes.get(part.resultNodeKey)
    if (!owner?.globalId || !resultNode) {
      throw new CadModelError('CAD evaluation lost the Geometry Tree owner for a scene part.')
    }
    const directPartCount = directPartCounts.get(part.ownerNodeKey) ?? 0
    const directPartOrdinal = directPartOrdinals[partIndex]
    const subtreePartCount = subtreePartCounts.get(owner.globalId) ?? 0
    const usesExactGeometryId = directPartCount === 1 && subtreePartCount === 1
    const id = usesExactGeometryId ? owner.globalId : `${owner.globalId}.$part-${directPartOrdinal}`
    const surfaces = part.surfaces.map((surface, surfaceIndex) => ({
      id: `${id}/surface-${surfaceIndex + 1}`,
      name: surface.name,
      polygonIndices: [...surface.polygonIndices],
    }))
    const surfaceNodes = surfaces.map((surface) => ({
      key: `${part.resultNodeKey}/${surface.id}`,
      label: surface.name,
      surfaceId: surface.id,
      children: [],
    }))
    if (usesExactGeometryId) {
      owner.geometryId = id
      resultNode.children.push(...surfaceNodes)
    } else {
      resultNode.children.push({
        key: `${part.resultNodeKey}/${id}`,
        label: `Part ${directPartOrdinal} · ${part.material?.name ?? 'Unassigned'}`,
        geometryId: id,
        children: surfaceNodes,
      })
    }

    let material: CadSceneMaterial | undefined
    if (part.material) {
      material = sceneMaterials.get(part.material)
      if (!material) {
        material = Object.freeze({
          name: part.material.name,
          ...(part.material.source === undefined ? {} : { source: part.material.source }),
          ...(part.material.version === undefined ? {} : { version: part.material.version }),
          errorRate: part.material.errorRate,
          variables: resolveMaterialVariables(part.material),
        })
        sceneMaterials.set(part.material, material)
      }
    }

    return {
      id,
      geometry: part.geometry,
      ...(material === undefined ? {} : { material }),
      surfaces,
    }
  })

  annotateGeometryNodes(tree)

  return applyCadSceneGroups({ lengthUnit, parts, tree, geometryGroups: [], surfaceGroups: [] }, groupOptions)
}

export function evaluateCad(root: unknown): CadScenePart[] {
  return evaluateCadScene(root).parts
}
