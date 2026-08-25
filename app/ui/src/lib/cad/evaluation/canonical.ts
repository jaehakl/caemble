import type { CadScene } from './types'
import type { CadSceneGroupOptions } from './groups'
import type {
  CanonicalGeometryNodeV1,
  CanonicalGeometryRootV1,
  CanonicalGeometrySceneDraftV1,
  CanonicalGeometrySceneV1,
  CanonicalSurfaceGroupV1,
  CanonicalSurfaceSelectorV1,
} from './canonicalTypes'
import { MAX_CANONICAL_GEOMETRY_TRIANGLES, MAX_CANONICAL_TASK_SCENES } from './canonicalTypes'
import { CadModelError } from '../model/errors'
import { assertUcumUnitComparable, normalizeUcumUnit } from '../model/units'

const drafts = new WeakMap<CadScene, CanonicalGeometrySceneDraftV1>()
const ordinalSurfacePattern = /(?:^|\/)surface-\d+$/u
const maxRoots = 10_000
const maxNodes = 100_000
const maxNodeDepth = 128
const maxArrayItems = 1_000_000
const maxSegments = 65_536
const maxBooleanOperands = 128
const maxBooleanWork = 100_000_000
const primitiveFaceKeys = Object.freeze({
  box: Object.freeze(['-X', '+X', '-Y', '+Y', 'Bottom', 'Top']),
  cylinder: Object.freeze(['Bottom', 'Side', 'Top']),
  sphere: Object.freeze(['Outer']),
  curvedEdgeCylinder: Object.freeze(['Bottom', 'Side', 'Top']),
  curvedSurfaceSphere: Object.freeze(['Outer']),
})

function sourceFaceIndex(
  node: CanonicalGeometryNodeV1,
  index = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  let faceKeys: readonly string[] | undefined
  if (node.kind === 'primitive') {
    faceKeys = primitiveFaceKeys[node.primitive]
    if (node.primitive === 'cylinder') {
      faceKeys = faceKeys.filter(
        (faceKey) =>
          (faceKey !== 'Bottom' || (node.parameters.radius as number) > 0) &&
          (faceKey !== 'Top' || (node.parameters.radius_2 as number) > 0),
      )
    }
  } else if (node.kind === 'fiber') {
    faceKeys = ['Start cap', 'Side', 'End cap']
  } else if (node.kind === 'boolean') {
    node.children.forEach((child) => sourceFaceIndex(child, index))
  } else if (node.kind === 'shell') {
    faceKeys = ['inner', 'outer']
  } else {
    sourceFaceIndex(node.child, index)
  }
  if (faceKeys) {
    const existing = index.get(node.nodeId)
    if (existing) faceKeys.forEach((faceKey) => existing.add(faceKey))
    else index.set(node.nodeId, new Set(faceKeys))
  }
  return index
}

function surfaceMember(memberId: string) {
  const marker = '/surface/'
  const markerIndex = memberId.lastIndexOf(marker)
  if (markerIndex <= 0 || markerIndex + marker.length === memberId.length) return undefined
  try {
    const sourceNodeId = memberId.slice(0, markerIndex)
    const faceKey = decodeURIComponent(memberId.slice(markerIndex + marker.length))
    if (!faceKey || `${sourceNodeId}${marker}${encodeURIComponent(faceKey)}` !== memberId) return undefined
    return { sourceNodeId, faceKey }
  } catch {
    return undefined
  }
}

function rootShellBoundary(
  node: CanonicalGeometryNodeV1,
): Extract<CanonicalGeometryNodeV1, { kind: 'shell' }> | undefined {
  let candidate = node
  while (candidate.kind === 'transform' || candidate.kind === 'instance') candidate = candidate.child
  return candidate.kind === 'shell' ? candidate : undefined
}

function canonicalSurfaceGroups(roots: readonly CanonicalGeometryRootV1[], options: CadSceneGroupOptions) {
  const matchesByMember = new Map<string, CanonicalSurfaceSelectorV1[]>()
  roots.forEach((root) => {
    const rootMatches = new Map<string, CanonicalSurfaceSelectorV1>()
    sourceFaceIndex(root.node).forEach((faceKeys, sourceNodeId) => {
      faceKeys.forEach((faceKey) => {
        rootMatches.set(JSON.stringify([sourceNodeId, faceKey]), { rootId: root.id, sourceNodeId, faceKey })
      })
    })
    const boundary = rootShellBoundary(root.node)
    if (boundary) {
      const shellFaceKeys = ['inner', 'outer'] as const
      shellFaceKeys.forEach((faceKey) => {
        rootMatches.set(JSON.stringify([root.id, faceKey]), {
          rootId: root.id,
          sourceNodeId: boundary.nodeId,
          faceKey,
        })
      })
    }
    rootMatches.forEach((selector, key) => {
      const matches = matchesByMember.get(key)
      if (matches) matches.push(selector)
      else matchesByMember.set(key, [selector])
    })
  })
  return Object.entries(options.surfaceGroup ?? {}).map(([name, memberIds]) => {
    const selectors: CanonicalSurfaceSelectorV1[] = []
    const missingMemberIds: string[] = []
    memberIds.forEach((memberId) => {
      const member = surfaceMember(memberId)
      if (!member) {
        missingMemberIds.push(memberId)
        return
      }
      const matches = matchesByMember.get(JSON.stringify([member.sourceNodeId, member.faceKey])) ?? []
      if (matches.length !== 1) {
        missingMemberIds.push(memberId)
        return
      }
      selectors.push(matches[0])
    })
    return {
      id: `@surface-group/${encodeURIComponent(name)}`,
      name,
      kind: 'surface' as const,
      memberIds: [...memberIds],
      selectors,
      missingMemberIds,
    }
  })
}

export function canonicalSurfaceMemberEntries(group: CanonicalSurfaceGroupV1) {
  const missing = new Set(group.missingMemberIds)
  let selectorIndex = 0
  return group.memberIds.flatMap((memberId) => {
    if (missing.has(memberId)) return []
    const selector = group.selectors[selectorIndex]
    selectorIndex += 1
    return selector ? [{ memberId, selector }] : []
  })
}

export function registerCanonicalGeometryScene(
  scene: CadScene,
  roots: readonly CanonicalGeometryRootV1[],
  options: CadSceneGroupOptions,
) {
  const draft: CanonicalGeometrySceneDraftV1 = {
    geometryFormatVersion: 1,
    lengthUnit: scene.lengthUnit,
    roots,
    geometryGroups: scene.geometryGroups.map((group) => ({
      id: group.id,
      name: group.name,
      kind: 'geometry',
      memberIds: [...group.memberIds],
      rootIds: [...group.geometryIds],
      missingMemberIds: [...group.missingMemberIds],
    })),
    surfaceGroups: canonicalSurfaceGroups(roots, options),
  }
  drafts.set(scene, draft)
  return draft
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new CadModelError('Canonical Geometry contains a non-serializable value.')
  return encoded
}

export async function canonicalGeometryScene(scene: CadScene): Promise<CanonicalGeometrySceneV1> {
  const draft = drafts.get(scene)
  if (!draft) throw new CadModelError('CAD evaluation lost its Canonical Geometry scene.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(draft)))
  const geometryHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return Object.freeze({ ...draft, geometryHash })
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError(`${path} must be an object.`)
  }
}

function isWellFormedNonEmptyString(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1)
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CadModelError(`${path} has invalid fields.`)
  }
}

function assertVec3(value: unknown, path: string) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    throw new CadModelError(`${path} must contain exactly three finite numbers.`)
  }
}

function assertFourier(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxArrayItems) {
    throw new CadModelError(`${path} must be a non-empty bounded array.`)
  }
  value.forEach((mode, index) => {
    assertRecord(mode, `${path}[${index}]`)
    assertKeys(mode, ['amplitude', 'phase'], `${path}[${index}]`)
    if (
      typeof mode.amplitude !== 'number' ||
      !Number.isFinite(mode.amplitude) ||
      mode.amplitude < 0 ||
      typeof mode.phase !== 'number' ||
      !Number.isFinite(mode.phase)
    ) {
      throw new CadModelError(`${path}[${index}] is invalid.`)
    }
  })
}

function assertNode(
  value: unknown,
  path: string,
  nodeIds: Set<string>,
  nodeCount: { value: number },
  depth: number,
): asserts value is CanonicalGeometryNodeV1 {
  assertRecord(value, path)
  if (depth > maxNodeDepth) throw new CadModelError(`${path} exceeds the maximum Geometry node depth.`)
  nodeCount.value += 1
  if (nodeCount.value > maxNodes) throw new CadModelError(`Canonical Geometry may contain at most ${maxNodes} nodes.`)
  if (!isWellFormedNonEmptyString(value.nodeId)) throw new CadModelError(`${path}.nodeId is invalid.`)
  if (nodeIds.has(value.nodeId)) throw new CadModelError(`${path}.nodeId is duplicated within its root.`)
  nodeIds.add(value.nodeId)
  if (value.kind === 'primitive') {
    if (!Object.prototype.hasOwnProperty.call(primitiveFaceKeys, String(value.primitive))) {
      throw new CadModelError(`${path}.primitive is invalid.`)
    }
    assertKeys(value, ['kind', 'nodeId', 'primitive', 'parameters'], path)
    assertRecord(value.parameters, `${path}.parameters`)
    const parameterKeys: Record<string, readonly string[]> = {
      box: ['size'],
      cylinder: ['radius', 'radius_2', 'height', 'segments'],
      sphere: ['radius', 'segments'],
      curvedEdgeCylinder: ['height', 'azimuthalCurve', 'verticalCurve', 'azimuthalSegments', 'verticalSegments'],
      curvedSurfaceSphere: ['azimuthalCurve', 'polarCurve', 'azimuthalSegments', 'polarSegments'],
    }
    assertKeys(value.parameters, parameterKeys[value.primitive as string]!, `${path}.parameters`)
    const parameters = value.parameters
    if (value.primitive === 'box') {
      assertVec3(parameters.size, `${path}.parameters.size`)
      if ((parameters.size as number[]).some((item) => item <= 0)) {
        throw new CadModelError(`${path}.parameters.size must be positive.`)
      }
    } else if (value.primitive === 'cylinder') {
      if (
        typeof parameters.radius !== 'number' ||
        !Number.isFinite(parameters.radius) ||
        parameters.radius < 0 ||
        typeof parameters.radius_2 !== 'number' ||
        !Number.isFinite(parameters.radius_2) ||
        parameters.radius_2 < 0 ||
        (parameters.radius === 0 && parameters.radius_2 === 0) ||
        typeof parameters.height !== 'number' ||
        !Number.isFinite(parameters.height) ||
        parameters.height <= 0 ||
        !Number.isSafeInteger(parameters.segments) ||
        (parameters.segments as number) < 4 ||
        (parameters.segments as number) > maxSegments
      ) {
        throw new CadModelError(`${path}.parameters is invalid for cylinder.`)
      }
    } else if (value.primitive === 'sphere') {
      if (
        typeof parameters.radius !== 'number' ||
        !Number.isFinite(parameters.radius) ||
        parameters.radius <= 0 ||
        !Number.isSafeInteger(parameters.segments) ||
        (parameters.segments as number) < 4 ||
        (parameters.segments as number) > maxSegments
      ) {
        throw new CadModelError(`${path}.parameters is invalid for sphere.`)
      }
    } else if (value.primitive === 'curvedEdgeCylinder') {
      assertFourier(parameters.azimuthalCurve, `${path}.parameters.azimuthalCurve`)
      assertRecord(parameters.verticalCurve, `${path}.parameters.verticalCurve`)
      assertKeys(parameters.verticalCurve, ['origin', 'coefficients'], `${path}.parameters.verticalCurve`)
      if (
        typeof parameters.height !== 'number' ||
        !Number.isFinite(parameters.height) ||
        parameters.height <= 0 ||
        typeof parameters.verticalCurve.origin !== 'number' ||
        !Number.isFinite(parameters.verticalCurve.origin) ||
        !Array.isArray(parameters.verticalCurve.coefficients) ||
        parameters.verticalCurve.coefficients.length === 0 ||
        parameters.verticalCurve.coefficients.length > maxArrayItems ||
        parameters.verticalCurve.coefficients.some((item) => typeof item !== 'number' || !Number.isFinite(item)) ||
        !Number.isSafeInteger(parameters.azimuthalSegments) ||
        (parameters.azimuthalSegments as number) < 4 ||
        (parameters.azimuthalSegments as number) > maxSegments ||
        !Number.isSafeInteger(parameters.verticalSegments) ||
        (parameters.verticalSegments as number) < 1 ||
        (parameters.verticalSegments as number) > maxSegments
      ) {
        throw new CadModelError(`${path}.parameters is invalid for curvedEdgeCylinder.`)
      }
    } else {
      assertFourier(parameters.azimuthalCurve, `${path}.parameters.azimuthalCurve`)
      assertFourier(parameters.polarCurve, `${path}.parameters.polarCurve`)
      if (
        !Number.isSafeInteger(parameters.azimuthalSegments) ||
        (parameters.azimuthalSegments as number) < 4 ||
        (parameters.azimuthalSegments as number) > maxSegments ||
        !Number.isSafeInteger(parameters.polarSegments) ||
        (parameters.polarSegments as number) < 2 ||
        (parameters.polarSegments as number) > maxSegments
      ) {
        throw new CadModelError(`${path}.parameters is invalid for curvedSurfaceSphere.`)
      }
    }
    return
  }
  if (value.kind === 'fiber') {
    assertKeys(value, ['kind', 'nodeId', 'points', 'radii', 'frames', 'radialSegments'], path)
    if (
      !Array.isArray(value.points) ||
      !Array.isArray(value.radii) ||
      !Array.isArray(value.frames) ||
      value.points.length < 2 ||
      value.points.length > maxArrayItems ||
      value.points.length !== value.radii.length ||
      value.points.length !== value.frames.length ||
      !Number.isSafeInteger(value.radialSegments) ||
      (value.radialSegments as number) < 3 ||
      (value.radialSegments as number) > maxSegments
    ) {
      throw new CadModelError(`${path} Fiber sampling is invalid.`)
    }
    value.points.forEach((point, index) => assertVec3(point, `${path}.points[${index}]`))
    value.radii.forEach((radius, index) => {
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
        throw new CadModelError(`${path}.radii[${index}] is invalid.`)
      }
    })
    value.frames.forEach((frame, index) => {
      assertRecord(frame, `${path}.frames[${index}]`)
      assertKeys(frame, ['tangent', 'normal', 'binormal'], `${path}.frames[${index}]`)
      assertVec3(frame.tangent, `${path}.frames[${index}].tangent`)
      assertVec3(frame.normal, `${path}.frames[${index}].normal`)
      assertVec3(frame.binormal, `${path}.frames[${index}].binormal`)
    })
    return
  }
  if (value.kind === 'transform' || value.kind === 'instance') {
    assertKeys(
      value,
      value.kind === 'instance'
        ? ['kind', 'nodeId', 'instanceId', 'matrix', 'child']
        : ['kind', 'nodeId', 'matrix', 'child'],
      path,
    )
    if (
      !Array.isArray(value.matrix) ||
      value.matrix.length !== 16 ||
      value.matrix.some((item) => typeof item !== 'number' || !Number.isFinite(item)) ||
      value.matrix[12] !== 0 ||
      value.matrix[13] !== 0 ||
      value.matrix[14] !== 0 ||
      value.matrix[15] !== 1 ||
      (value.kind === 'instance' && !isWellFormedNonEmptyString(value.instanceId))
    ) {
      throw new CadModelError(`${path} affine transform is invalid.`)
    }
    assertNode(value.child, `${path}.child`, nodeIds, nodeCount, depth + 1)
    return
  }
  if (value.kind === 'boolean') {
    assertKeys(value, ['kind', 'nodeId', 'operation', 'children'], path)
    if (
      !['union', 'subtract', 'intersect'].includes(String(value.operation)) ||
      !Array.isArray(value.children) ||
      (value.operation === 'union' ? value.children.length < 1 : value.children.length < 2)
    ) {
      throw new CadModelError(`${path} Boolean operation is invalid.`)
    }
    if (value.children.length > maxBooleanOperands) {
      throw new CadModelError(`${path} Boolean operation may contain at most ${maxBooleanOperands} operands.`)
    }
    if (value.children.length > maxArrayItems) throw new CadModelError(`${path}.children is too large.`)
    value.children.forEach((child, index) =>
      assertNode(child, `${path}.children[${index}]`, nodeIds, nodeCount, depth + 1),
    )
    return
  }
  if (value.kind === 'shell') {
    assertKeys(value, ['kind', 'nodeId', 'innerOffset', 'outerOffset', 'child'], path)
    if (
      typeof value.innerOffset !== 'number' ||
      !Number.isFinite(value.innerOffset) ||
      typeof value.outerOffset !== 'number' ||
      !Number.isFinite(value.outerOffset) ||
      value.innerOffset >= value.outerOffset
    ) {
      throw new CadModelError(`${path} Shell offsets are invalid.`)
    }
    assertNode(value.child, `${path}.child`, nodeIds, nodeCount, depth + 1)
    return
  }
  throw new CadModelError(`${path}.kind is invalid.`)
}

function estimatedTriangleCount(node: CanonicalGeometryNodeV1): number {
  if (node.kind === 'primitive') {
    if (node.primitive === 'box') return 12
    if (node.primitive === 'cylinder') return 4 * (node.parameters.segments as number)
    if (node.primitive === 'sphere') {
      const segments = node.parameters.segments as number
      return 2 * segments * segments
    }
    if (node.primitive === 'curvedEdgeCylinder') {
      return 2 * (node.parameters.azimuthalSegments as number) * ((node.parameters.verticalSegments as number) + 1)
    }
    return 2 * (node.parameters.azimuthalSegments as number) * ((node.parameters.polarSegments as number) - 1)
  }
  if (node.kind === 'fiber') return 2 * node.radialSegments * node.points.length
  if (node.kind === 'boolean') {
    return node.children.reduce((total, child) => total + estimatedTriangleCount(child), 0)
  }
  if (node.kind === 'shell') return 2 * estimatedTriangleCount(node.child)
  return estimatedTriangleCount(node.child)
}

function estimatedBooleanWork(node: CanonicalGeometryNodeV1): number {
  if (node.kind === 'primitive' || node.kind === 'fiber') return 0
  if (node.kind !== 'boolean') return estimatedBooleanWork(node.child)
  let work = 0
  let precedingTriangles = 0
  for (const child of node.children) {
    const childTriangles = estimatedTriangleCount(child)
    work += estimatedBooleanWork(child) + precedingTriangles * childTriangles
    if (work > maxBooleanWork) return maxBooleanWork + 1
    precedingTriangles += childTriangles
  }
  return work
}

export function assertCanonicalTaskSceneCount(taskScenes: Readonly<Record<string, unknown>>) {
  if (Object.keys(taskScenes).length > MAX_CANONICAL_TASK_SCENES) {
    throw new CadModelError(`An Experiment may contain at most ${MAX_CANONICAL_TASK_SCENES} Task Geometry scenes.`)
  }
}

export function assertCanonicalGeometryRunBudget(
  scene: CanonicalGeometrySceneV1,
  taskScenes: Readonly<Record<string, CanonicalGeometrySceneV1>>,
) {
  assertCanonicalTaskSceneCount(taskScenes)
  const tasks = Object.values(taskScenes)
  const uniqueRoots = new Set<string>()
  let triangles = 0
  let booleanWork = 0
  const scenes = [scene, ...tasks]
  scenes.forEach((candidate) => {
    candidate.roots.forEach((root) => {
      const key = JSON.stringify([candidate.geometryHash, root.id])
      if (uniqueRoots.has(key)) return
      uniqueRoots.add(key)
      triangles += estimatedTriangleCount(root.node)
      booleanWork += estimatedBooleanWork(root.node)
    })
  })
  if (triangles > MAX_CANONICAL_GEOMETRY_TRIANGLES) {
    throw new CadModelError(
      `Experiment and Task Geometry scenes exceed the ${MAX_CANONICAL_GEOMETRY_TRIANGLES.toLocaleString('en-US')} aggregate derived-triangle limit.`,
    )
  }
  if (booleanWork > maxBooleanWork) {
    throw new CadModelError(
      `Experiment and Task Geometry scenes exceed the ${maxBooleanWork.toLocaleString('en-US')} aggregate Boolean triangle-pair work limit.`,
    )
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxArrayItems) {
    throw new CadModelError(`${path} must be a bounded array of non-empty strings.`)
  }
  const seen = new Set<string>()
  value.forEach((item, index) => {
    if (!isWellFormedNonEmptyString(item)) {
      throw new CadModelError(`${path}[${index}] must be a non-empty well-formed Unicode string.`)
    }
    if (seen.has(item)) throw new CadModelError(`${path} values must be unique.`)
    seen.add(item)
  })
}

export function assertCanonicalGeometryScene(value: unknown): asserts value is CanonicalGeometrySceneV1 {
  assertRecord(value, 'Canonical Geometry scene')
  assertKeys(
    value,
    ['geometryFormatVersion', 'geometryHash', 'lengthUnit', 'roots', 'geometryGroups', 'surfaceGroups'],
    'Canonical Geometry scene',
  )
  if (
    value.geometryFormatVersion !== 1 ||
    typeof value.geometryHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.geometryHash)
  ) {
    throw new CadModelError('Canonical Geometry scene version or hash is invalid.')
  }
  if (!isWellFormedNonEmptyString(value.lengthUnit)) {
    throw new CadModelError('Canonical Geometry scene lengthUnit is invalid.')
  }
  const lengthUnit = normalizeUcumUnit(value.lengthUnit, 'Canonical Geometry scene lengthUnit')
  assertUcumUnitComparable(lengthUnit, 'm', 'Canonical Geometry scene lengthUnit')
  if (
    !Array.isArray(value.roots) ||
    value.roots.length > maxRoots ||
    !Array.isArray(value.geometryGroups) ||
    !Array.isArray(value.surfaceGroups)
  ) {
    throw new CadModelError('Canonical Geometry scene collections are invalid.')
  }
  const rootIds = new Set<string>()
  const roots = new Map<string, CanonicalGeometryRootV1>()
  const rootSourceFaces = new Map<string, Map<string, Set<string>>>()
  const rootShellBoundaries = new Map<string, Extract<CanonicalGeometryNodeV1, { kind: 'shell' }>>()
  const nodeCount = { value: 0 }
  let estimatedTriangles = 0
  let booleanWork = 0
  value.roots.forEach((root, index) => {
    const path = `Canonical Geometry scene.roots[${index}]`
    assertRecord(root, path)
    assertKeys(
      root,
      root.material === undefined ? ['id', 'materialRole', 'node'] : ['id', 'materialRole', 'material', 'node'],
      path,
    )
    if (!isWellFormedNonEmptyString(root.id) || !isWellFormedNonEmptyString(root.materialRole)) {
      throw new CadModelError(`${path} identity is invalid.`)
    }
    if (rootIds.has(root.id)) throw new CadModelError('Canonical Geometry scene root ids must be unique.')
    rootIds.add(root.id)
    if (root.material !== undefined) {
      assertRecord(root.material, `${path}.material`)
      const materialKeys = [
        'name',
        ...(root.material.source === undefined ? [] : ['source']),
        ...(root.material.version === undefined ? [] : ['version']),
      ]
      assertKeys(root.material, materialKeys, `${path}.material`)
      if (
        !isWellFormedNonEmptyString(root.material.name) ||
        (root.material.source !== undefined && !isWellFormedNonEmptyString(root.material.source)) ||
        (root.material.version !== undefined && !isWellFormedNonEmptyString(root.material.version))
      ) {
        throw new CadModelError(`${path}.material is invalid.`)
      }
    }
    assertNode(root.node, `${path}.node`, new Set<string>(), nodeCount, 1)
    estimatedTriangles += estimatedTriangleCount(root.node)
    if (estimatedTriangles > MAX_CANONICAL_GEOMETRY_TRIANGLES) {
      throw new CadModelError(
        `Canonical Geometry scene exceeds the ${MAX_CANONICAL_GEOMETRY_TRIANGLES.toLocaleString('en-US')} triangle preview limit.`,
      )
    }
    booleanWork += estimatedBooleanWork(root.node)
    if (booleanWork > maxBooleanWork) {
      throw new CadModelError(
        `Canonical Geometry scene exceeds the ${maxBooleanWork.toLocaleString('en-US')} Boolean triangle-pair work limit.`,
      )
    }
    roots.set(root.id, root as CanonicalGeometryRootV1)
    rootSourceFaces.set(root.id, sourceFaceIndex(root.node))
    const boundary = rootShellBoundary(root.node)
    if (boundary) rootShellBoundaries.set(root.id, boundary)
  })
  const geometryGroupIds = new Set<string>()
  const geometryGroupNames = new Set<string>()
  value.geometryGroups.forEach((group, index) => {
    const path = `Canonical Geometry scene.geometryGroups[${index}]`
    assertRecord(group, path)
    assertKeys(group, ['id', 'name', 'kind', 'memberIds', 'rootIds', 'missingMemberIds'], path)
    if (group.kind !== 'geometry' || !isWellFormedNonEmptyString(group.id) || !isWellFormedNonEmptyString(group.name)) {
      throw new CadModelError(`${path} is invalid.`)
    }
    if (geometryGroupIds.has(group.id)) throw new CadModelError('Canonical Geometry geometry group ids must be unique.')
    if (geometryGroupNames.has(group.name)) {
      throw new CadModelError('Canonical Geometry geometry group names must be unique.')
    }
    geometryGroupIds.add(group.id)
    geometryGroupNames.add(group.name)
    const memberIds = group.memberIds
    const missingMemberIds = group.missingMemberIds
    assertStringArray(memberIds, `${path}.memberIds`)
    assertStringArray(group.rootIds, `${path}.rootIds`)
    assertStringArray(missingMemberIds, `${path}.missingMemberIds`)
    if (group.rootIds.some((rootId) => !rootIds.has(rootId))) {
      throw new CadModelError(`${path}.rootIds references a missing root.`)
    }
    const memberIdSet = new Set(memberIds)
    if (missingMemberIds.some((memberId) => !memberIdSet.has(memberId))) {
      throw new CadModelError(`${path}.missingMemberIds must be a subset of memberIds.`)
    }
  })
  const surfaceGroupIds = new Set<string>()
  const surfaceGroupNames = new Set<string>()
  value.surfaceGroups.forEach((group, index) => {
    const path = `Canonical Geometry scene.surfaceGroups[${index}]`
    assertRecord(group, path)
    assertKeys(group, ['id', 'name', 'kind', 'memberIds', 'selectors', 'missingMemberIds'], path)
    if (
      group.kind !== 'surface' ||
      !isWellFormedNonEmptyString(group.id) ||
      !isWellFormedNonEmptyString(group.name) ||
      !Array.isArray(group.selectors) ||
      group.selectors.length > maxArrayItems
    ) {
      throw new CadModelError(`${path} is invalid.`)
    }
    if (surfaceGroupIds.has(group.id)) throw new CadModelError('Canonical Geometry surface group ids must be unique.')
    if (surfaceGroupNames.has(group.name)) {
      throw new CadModelError('Canonical Geometry surface group names must be unique.')
    }
    surfaceGroupIds.add(group.id)
    surfaceGroupNames.add(group.name)
    const memberIds = group.memberIds
    const missingMemberIds = group.missingMemberIds
    assertStringArray(memberIds, `${path}.memberIds`)
    assertStringArray(missingMemberIds, `${path}.missingMemberIds`)
    if (
      memberIds.some((memberId) => ordinalSurfacePattern.test(memberId)) ||
      missingMemberIds.some((memberId) => ordinalSurfacePattern.test(memberId))
    ) {
      throw new CadModelError(`${path} uses an ordinal /surface-N id; migrate the Geometry to semantic surfaces.`)
    }
    const memberIdSet = new Set(memberIds)
    const missingMemberIdSet = new Set(missingMemberIds)
    if (missingMemberIds.some((memberId) => !memberIdSet.has(memberId))) {
      throw new CadModelError(`${path}.missingMemberIds must be a subset of memberIds.`)
    }
    const resolvedMemberIds = memberIds.filter((memberId) => !missingMemberIdSet.has(memberId))
    if (group.selectors.length !== resolvedMemberIds.length) {
      throw new CadModelError(`${path}.selectors must correspond exactly to its resolved memberIds.`)
    }
    const selectorKeys = new Set<string>()
    group.selectors.forEach((selector, selectorIndex) => {
      const selectorPath = `${path}.selectors[${selectorIndex}]`
      assertRecord(selector, selectorPath)
      assertKeys(selector, ['rootId', 'sourceNodeId', 'faceKey'], selectorPath)
      if (
        !isWellFormedNonEmptyString(selector.rootId) ||
        !isWellFormedNonEmptyString(selector.sourceNodeId) ||
        !isWellFormedNonEmptyString(selector.faceKey) ||
        ordinalSurfacePattern.test(selector.faceKey)
      ) {
        throw new CadModelError(`${selectorPath} must use non-empty semantic references.`)
      }
      const root = roots.get(selector.rootId)
      if (!root) throw new CadModelError(`${selectorPath}.rootId references a missing root.`)
      if (!rootSourceFaces.get(selector.rootId)?.get(selector.sourceNodeId)?.has(selector.faceKey)) {
        throw new CadModelError(`${selectorPath} does not identify a semantic source face.`)
      }
      const member = surfaceMember(resolvedMemberIds[selectorIndex])
      const boundary = rootShellBoundaries.get(selector.rootId)
      const usesRootShellAlias =
        member?.sourceNodeId === selector.rootId &&
        boundary?.nodeId === selector.sourceNodeId &&
        (selector.faceKey === 'inner' || selector.faceKey === 'outer')
      if (
        !member ||
        member.faceKey !== selector.faceKey ||
        (member.sourceNodeId !== selector.sourceNodeId && !usesRootShellAlias)
      ) {
        throw new CadModelError(`${selectorPath} does not match its positional semantic memberId.`)
      }
      const selectorKey = JSON.stringify([selector.rootId, selector.sourceNodeId, selector.faceKey])
      if (selectorKeys.has(selectorKey)) throw new CadModelError(`${path}.selectors must be unique.`)
      selectorKeys.add(selectorKey)
    })
  })
}
