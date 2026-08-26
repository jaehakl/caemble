import { CadModelError, Material, resolveMaterialVariables } from '../model/core'
import { deriveGeometrySurfaces } from '../geometry/surfaces'
import { getCadElementDefinition } from './registry'
import { flattenValues, Fragment, isCadNode } from './jsx'
import { applyTransforms, normalizeTransforms } from './transforms'
import { applyCadSceneGroups, type CadSceneGroupOptions } from './groups'
import { canonicalPrimitiveNode } from './canonicalPrimitive'
import { canonicalSurfaceMemberEntries, registerCanonicalGeometryScene } from './canonical'
import type { CanonicalGeometryNodeV1, CanonicalGeometryRootV1 } from './canonicalTypes'
import type {
  CadScene,
  CadSceneMaterial,
  CadScenePart,
  CadSceneTreeNode,
  CadNode,
  EvaluatedPart,
  MaterialBinding,
} from './types'
import { normalizeUcumUnit, type UcumUnit } from '../model/units'

type EvaluationState = {
  nodes: Map<string, CadSceneTreeNode>
  explicitIdsByParent: Map<string, Set<string>>
  localIdsByParent: Map<string, Set<string>>
  rootLabel: string
}

const localGeometryIdPattern = /^[\p{L}\p{N}_-]+$/u

const bindingByExposedMaterial = new WeakMap<Material, MaterialBinding>()
const exposedMaterialsByBindings = new WeakMap<Map<string, MaterialBinding>, Readonly<Record<string, Material>>>()

function createMaterialBinding(role: string, material?: Material): MaterialBinding {
  const exposed = new Proxy(material ?? new Material(role), {})
  const binding = Object.freeze({ role, ...(material === undefined ? {} : { material }), exposed })
  bindingByExposedMaterial.set(exposed, binding)
  return binding
}

function assertMaterialRole(role: string) {
  if (!role.trim()) throw new CadModelError('Geometry material roles must not be blank.')
  if (role !== role.trim()) {
    throw new CadModelError(`Geometry material role ${JSON.stringify(role)} must not have surrounding whitespace.`)
  }
}

function materialBinding(bindings: Map<string, MaterialBinding>, role: string) {
  assertMaterialRole(role)
  const existing = bindings.get(role)
  if (existing) return existing
  const unresolved = createMaterialBinding(role)
  bindings.set(role, unresolved)
  return unresolved
}

function exposeMaterials(bindings: Map<string, MaterialBinding>) {
  const cached = exposedMaterialsByBindings.get(bindings)
  if (cached) return cached
  const target = Object.freeze(
    Object.fromEntries([...bindings].map(([role, binding]) => [role, binding.exposed])),
  ) as Record<string, Material>
  const exposed = new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property !== 'string' || Object.prototype.hasOwnProperty.call(current, property)) {
        return Reflect.get(current, property, receiver)
      }
      return materialBinding(bindings, property).exposed
    },
  })
  exposedMaterialsByBindings.set(bindings, exposed)
  return exposed
}

function resolveMaterials(value: unknown, inherited: Map<string, MaterialBinding>) {
  if (value === undefined) return inherited
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Geometry materials must be an object mapping roles to Material instances.')
  }
  const bindings = new Map<string, MaterialBinding>()
  Object.entries(value).forEach(([role, material]) => {
    assertMaterialRole(role)
    if (material === undefined) {
      bindings.set(role, createMaterialBinding(role))
      return
    }
    if (!(material instanceof Material)) {
      throw new CadModelError(`Geometry material role ${JSON.stringify(role)} must contain a Material instance or undefined.`)
    }
    bindings.set(role, bindingByExposedMaterial.get(material) ?? createMaterialBinding(role, material))
  })
  return bindings
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
    throw new CadModelError(`Geometry id ${JSON.stringify(value)} must be unique within parent ${JSON.stringify(parentId || state.rootLabel)}.`)
  }
  siblingIds.add(value)
  state.localIdsByParent.set(parentId, siblingIds)
  return parentId ? `${parentId}.${value}` : value
}

function automaticGeometryId(authoringName: string, parentId: string, state: EvaluationState) {
  const base =
    authoringName
      .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
      .replace(/[^A-Za-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .toLowerCase() || 'geometry'
  const siblingIds = state.localIdsByParent.get(parentId) ?? new Set<string>()
  const explicitIds = state.explicitIdsByParent.get(parentId)
  let localId = base
  let ordinal = 2
  while (siblingIds.has(localId) || explicitIds?.has(localId)) {
    localId = `${base}-${ordinal}`
    ordinal += 1
  }
  siblingIds.add(localId)
  state.localIdsByParent.set(parentId, siblingIds)
  return { localId, globalId: parentId ? `${parentId}.${localId}` : localId }
}

function reserveExplicitSiblingIds(values: readonly unknown[], parentId: string, state: EvaluationState) {
  const ids = state.explicitIdsByParent.get(parentId) ?? new Set<string>()
  flattenValues(values).forEach((value) => {
    if (isCadNode(value) && typeof value.props.id === 'string') ids.add(value.props.id)
  })
  if (ids.size) state.explicitIdsByParent.set(parentId, ids)
}

function primitiveProps(defaults: Readonly<Record<string, unknown>>, props: Record<string, unknown>) {
  const resolved = { ...defaults }
  Object.entries(props).forEach(([name, value]) => {
    if (value !== undefined) resolved[name] = value
  })
  return resolved
}

function evaluateNode(
  value: unknown,
  inheritedMaterials: Map<string, MaterialBinding>,
  state: EvaluationState,
  traceParent: CadSceneTreeNode,
  nodeKey: string,
  identityParent: string,
  ownerNodeKey: string | undefined,
): EvaluatedPart[] {
  if (Array.isArray(value)) {
    reserveExplicitSiblingIds(value, identityParent, state)
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
  const node = value as CadNode
  const { children, props, type } = node
  if (type === Fragment) {
    reserveExplicitSiblingIds(children, identityParent, state)
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
    const identity =
      props.id === undefined
        ? automaticGeometryId(type.name || 'geometry', identityParent, state)
        : { localId: props.id as string, globalId: resolveGeometryId(props.id, label, identityParent, state) }
    const globalId = identity.globalId
    const traceNode = addTreeNode(state, traceParent, nodeKey, label, globalId)
    const owner = `Geometry ${type.name || '<anonymous>'}`
    const transformValues = normalizeTransforms(props, owner)
    const materials = resolveMaterials(props.materials, inheritedMaterials)
    const result = type({
      ...props,
      id: identity.localId,
      position: transformValues.position,
      rotation: transformValues.rotation,
      scale: transformValues.scale,
      materials: exposeMaterials(materials),
      children,
    })
    return applyTransforms(
      evaluateNode(result, materials, state, traceNode, `${nodeKey}/result`, globalId, traceNode.key),
      transformValues,
      `${globalId}/$component-transform`,
    )
  }

  const definition = getCadElementDefinition(type)!
  const resolvedProps = definition.kind === 'primitive' ? primitiveProps(definition.defaultProps, props) : props
  const primitiveIdentity =
    definition.kind === 'primitive' && props.id === undefined
      ? automaticGeometryId(definition.manifest.authoringName, identityParent, state)
      : null
  const globalId =
    primitiveIdentity?.globalId ??
    (props.id === undefined ? undefined : resolveGeometryId(props.id, `<${type}>`, identityParent, state))
  const traceNode = addTreeNode(state, traceParent, nodeKey, `<${type}>`, globalId)
  const elementIdentityParent = globalId ?? identityParent
  const elementOwnerNodeKey = globalId === undefined ? ownerNodeKey : traceNode.key
  const transformValues = normalizeTransforms(resolvedProps, `<${type}>`)
  let parts: EvaluatedPart[]

  if (definition.kind === 'primitive') {
    const binding = materialBinding(inheritedMaterials, 'body')

    const geometry = definition.createGeometry(resolvedProps)
    parts = [
      {
        geometry,
        canonicalNode: canonicalPrimitiveNode(definition.tag, globalId!, resolvedProps, geometry),
        materialRole: binding.role,
        ...(binding.material === undefined ? {} : { material: binding.material }),
        surfaces: definition.createSurfaces(geometry, resolvedProps),
        ownerNodeKey: elementOwnerNodeKey!,
        resultNodeKey: nodeKey,
      },
    ]
  } else {
    reserveExplicitSiblingIds(children, elementIdentityParent, state)
    let childIndex = 0
    parts = definition.evaluate(node, {
      nodeId: globalId ?? nodeKey,
      inheritedMaterials,
      evaluate: (child, materials = inheritedMaterials, trace) => {
        if (trace) {
          const wrapperKey = `${nodeKey}/${trace.key}`
          const wrapper = addTreeNode(state, traceNode, wrapperKey, trace.label)
          const childIdentityParent = trace.identitySegment
            ? `${elementIdentityParent ? `${elementIdentityParent}.` : ''}${trace.identitySegment}`
            : elementIdentityParent
          return evaluateNode(
            child,
            materials,
            state,
            wrapper,
            `${wrapperKey}/value`,
            childIdentityParent,
            elementOwnerNodeKey,
          )
        }

        const childKey = `${nodeKey}/child-${childIndex}`
        childIndex += 1
        return evaluateNode(child, materials, state, traceNode, childKey, elementIdentityParent, elementOwnerNodeKey)
      },
    })

    if (definition.surfacePolicy === 'derive') {
      parts = parts.map((part) => {
        const derived = deriveGeometrySurfaces(part.geometry)
        return {
          ...part,
          geometry: derived.geometry,
          surfaces: derived.surfaces,
          ownerNodeKey: elementOwnerNodeKey,
          resultNodeKey: nodeKey,
        }
      })
    }
  }

  return applyTransforms(parts, transformValues, `${globalId ?? nodeKey}/$element-transform`)
}

export function evaluateCadScene(
  root: unknown,
  groupOptions: CadSceneGroupOptions = {},
  rootLabel = 'Experiment',
  rawLengthUnit: UcumUnit = 'm',
): CadScene {
  const lengthUnit = normalizeUcumUnit(rawLengthUnit, `${rootLabel} scene lengthUnit`)
  const rootKey = rootLabel.toLowerCase()
  const tree: CadSceneTreeNode = { key: rootKey, label: rootLabel, children: [] }
  const state: EvaluationState = {
    nodes: new Map([[tree.key, tree]]),
    explicitIdsByParent: new Map(),
    localIdsByParent: new Map(),
    rootLabel,
  }
  const evaluatedParts = evaluateNode(root, new Map(), state, tree, `${rootKey}/root`, '', undefined)

  const ownerIds = evaluatedParts.map((part) => {
    const owner = state.nodes.get(part.ownerNodeKey!)!
    return owner.globalId!
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
  const canonicalRoots: CanonicalGeometryRootV1[] = []
  const identifyRootShell = (node: CanonicalGeometryNodeV1, rootId: string): CanonicalGeometryNodeV1 => {
    if (node.kind === 'transform' || node.kind === 'instance') {
      return { ...node, child: identifyRootShell(node.child, rootId) }
    }
    return node.kind === 'shell' ? { ...node, nodeId: rootId } : node
  }
  const parts: CadScenePart[] = evaluatedParts.map((part, partIndex) => {
    const owner = state.nodes.get(part.ownerNodeKey!)!
    const resultNode = state.nodes.get(part.resultNodeKey!)!
    const ownerId = owner.globalId!
    const directPartCount = directPartCounts.get(part.ownerNodeKey!) ?? 0
    const directPartOrdinal = directPartOrdinals[partIndex]
    const subtreePartCount = subtreePartCounts.get(ownerId) ?? 0
    const usesExactGeometryId = directPartCount === 1 && subtreePartCount === 1
    const id = usesExactGeometryId ? ownerId : `${ownerId}.$part-${directPartOrdinal}`
    const surfaces = part.surfaces!.map((surface) => ({
      id: `${id}/surface/${surface.surfaceIndex}`,
      surfaceIndex: surface.surfaceIndex,
      label: surface.label,
      polygonIndices: [...surface.polygonIndices],
    }))
    const surfaceNodes = surfaces.map((surface) => ({
      key: `${part.resultNodeKey}/${surface.id}`,
      label: `${surface.surfaceIndex} · ${surface.label}`,
      surfaceId: surface.id,
      children: [],
    }))
    if (usesExactGeometryId) {
      owner.geometryId = id
      resultNode.children.push(...surfaceNodes)
    } else {
      resultNode.children.push({
        key: `${part.resultNodeKey}/${id}`,
        label: `Part ${directPartOrdinal} · ${part.material?.name ?? part.materialRole}`,
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

    canonicalRoots.push({
      id,
      materialRole: part.materialRole,
      ...(part.material === undefined
        ? {}
        : {
            material: {
              name: part.material.name,
              ...(part.material.source === undefined ? {} : { source: part.material.source }),
              ...(part.material.version === undefined ? {} : { version: part.material.version }),
            },
          }),
      node: identifyRootShell(part.canonicalNode, id),
    })

    return {
      id,
      geometry: part.geometry,
      materialRole: part.materialRole,
      ...(material === undefined ? {} : { material }),
      surfaces,
    }
  })

  annotateGeometryNodes(tree)

  const scene = applyCadSceneGroups({ lengthUnit, parts, tree, geometryGroups: [], surfaceGroups: [] }, groupOptions)
  const canonical = registerCanonicalGeometryScene(scene, canonicalRoots, groupOptions)
  scene.surfaceGroups = canonical.surfaceGroups.map((group) => {
    const entries = canonicalSurfaceMemberEntries(group)
    entries.forEach(({ memberId, selector }) => {
      const part = scene.parts.find((candidate) => candidate.id === selector.rootId)
      if (part && !part.surfaces.some((surface) => surface.id === memberId)) {
        part.surfaces.push({
          id: memberId,
          surfaceIndex: selector.surfaceIndex,
          label: `Surface ${selector.surfaceIndex}`,
          polygonIndices: [],
        })
      }
    })
    return {
      id: group.id,
      name: group.name,
      kind: 'surface',
      memberIds: [...group.memberIds],
      geometryIds: [...new Set(group.selectors.map((selector) => selector.rootId))],
      surfaceIds: entries.map((entry) => entry.memberId),
      missingMemberIds: [...group.missingMemberIds],
    }
  })
  return scene
}

export function evaluateCad(root: unknown): CadScenePart[] {
  return evaluateCadScene(root).parts
}
