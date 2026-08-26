import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { DRAFT_TASK_KERNEL } from '@/lib/catalog/draftTask'
import type { EvaluatedRuntimeDocumentSnapshot } from '../execution/snapshot'
import type { CadScene, CadScenePart } from '../evaluation/types'
import { CadModelError } from '../model/errors'
import { convertUcumValue } from '../model/units'
import type {
  KernelContractIssue,
  KernelDescriptor,
  KernelMethodDescriptor,
  KernelOutputMethodDescriptor,
  KernelValueSpec,
} from './kernelContract/types'

const dataDTypes = new Set([
  'bool',
  'string',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float16',
  'float32',
  'float64',
])
const integerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
})
const recordedDataNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u
const methodCategories = ['initializations', 'boundaryConditions', 'outputs'] as const

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function addIssue(issues: KernelContractIssue[], path: string, message: string) {
  issues.push(Object.freeze({ path, message }))
}

function validateBasis(value: unknown, path: string, issues: KernelContractIssue[]) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (axis) =>
        !Array.isArray(axis) ||
        axis.length !== 3 ||
        axis.some((component) => typeof component !== 'number' || !Number.isFinite(component)),
    )
  ) {
    addIssue(issues, path, 'must contain three Cartesian basis vectors of three finite numbers.')
    return
  }
  const basis = value as readonly (readonly number[])[]
  const tolerance = 1e-9
  for (let left = 0; left < 3; left += 1) {
    for (let right = left; right < 3; right += 1) {
      const dot = basis[left][0] * basis[right][0] + basis[left][1] * basis[right][1] + basis[left][2] * basis[right][2]
      if (Math.abs(dot - (left === right ? 1 : 0)) > tolerance) {
        addIssue(issues, path, 'must be an orthonormal Cartesian basis.')
        return
      }
    }
  }
  const determinant =
    basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1]) -
    basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0]) +
    basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0])
  if (Math.abs(determinant - 1) > tolerance) addIssue(issues, path, 'must be right-handed.')
}

function validateElement(value: unknown, dtype: string, path: string, issues: KernelContractIssue[]) {
  if (dtype === 'bool') {
    if (typeof value !== 'boolean') addIssue(issues, path, 'must be a bool value.')
    return
  }
  if (dtype === 'string') {
    if (typeof value !== 'string') addIssue(issues, path, 'must be a string value.')
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, path, `must be a finite ${dtype} value.`)
    return
  }
  const range = integerRanges[dtype]
  if (range && (!Number.isSafeInteger(value) || value < range[0] || value > range[1])) {
    addIssue(issues, path, `must be a safe ${dtype} integer in [${range[0]}, ${range[1]}].`)
  } else if (dtype === 'float16' && Math.abs(value) > 65_504) {
    addIssue(issues, path, 'must be representable as a finite float16 value.')
  } else if (dtype === 'float32' && !Number.isFinite(Math.fround(value))) {
    addIssue(issues, path, 'must be representable as a finite float32 value.')
  }
}

function dataLeaves(
  value: unknown,
  shape: readonly number[],
  path: string,
  dtype: string,
  issues: KernelContractIssue[],
) {
  const leaves: unknown[] = []
  const visit = (item: unknown, depth: number, itemPath: string): boolean => {
    if (depth === shape.length) {
      if (Array.isArray(item)) {
        addIssue(issues, itemPath, `must have shape ${JSON.stringify(shape)}.`)
        return false
      }
      validateElement(item, dtype, itemPath, issues)
      leaves.push(item)
      return true
    }
    if (!Array.isArray(item) || item.length !== shape[depth]) {
      addIssue(issues, itemPath, `must have shape ${JSON.stringify(shape)}.`)
      return false
    }
    return item.every((child, index) => visit(child, depth + 1, `${itemPath}[${index}]`))
  }
  visit(value, 0, path)
  return leaves
}

function quantityKind(catalog: CatalogRuntimeSlice, name: unknown) {
  return typeof name === 'string' ? catalog.quantityKinds.find((candidate) => candidate.name === name) : undefined
}

function compatibleUnit(value: unknown, expected: unknown, path: string, issues: KernelContractIssue[]) {
  if (typeof value !== 'string' || !value || typeof expected !== 'string' || !expected) {
    addIssue(issues, path, 'must be a non-empty compatible UCUM unit.')
    return false
  }
  try {
    convertUcumValue(1, value, expected, path)
    return true
  } catch (error) {
    addIssue(issues, path, error instanceof Error ? error.message : `cannot convert ${value} to ${expected}.`)
    return false
  }
}

function validateValue(
  value: unknown,
  spec: KernelValueSpec,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
  materialValue = false,
) {
  const descriptor = isRecord(value) ? value : undefined
  const float = spec.dtype === 'float16' || spec.dtype === 'float32' || spec.dtype === 'float64'
  if ((float || spec.axes !== undefined) && !descriptor) {
    addIssue(issues, path, 'must be an explicit dtype descriptor.')
    return
  }
  if (descriptor) {
    const allowed = new Set([
      'dtype',
      'value',
      'axes',
      'unit',
      'quantityKind',
      'basis',
      ...(materialValue ? ['errorRate'] : []),
    ])
    Reflect.ownKeys(descriptor).forEach((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) addIssue(issues, `${path}.${String(key)}`, 'is not allowed.')
    })
    if (descriptor.dtype !== spec.dtype) addIssue(issues, `${path}.dtype`, `must be ${spec.dtype}.`)
  }

  let tensorOrder = 0
  let unitCompatible = true
  if (float) {
    if (descriptor?.quantityKind !== spec.quantityKind) {
      addIssue(issues, `${path}.quantityKind`, `must be ${spec.quantityKind}.`)
    }
    const kind = quantityKind(catalog, spec.quantityKind)
    tensorOrder = kind?.tensorOrder ?? 0
    unitCompatible = compatibleUnit(descriptor?.unit, spec.unit, `${path}.unit`, issues)
    if (tensorOrder === 0 && descriptor?.basis !== undefined) {
      addIssue(issues, `${path}.basis`, 'is forbidden for a scalar Quantity Kind.')
    } else if (tensorOrder > 0 && descriptor?.basis !== undefined) {
      validateBasis(descriptor.basis, `${path}.basis`, issues)
    }
  } else if (
    descriptor &&
    (descriptor.unit !== undefined || descriptor.quantityKind !== undefined || descriptor.basis !== undefined)
  ) {
    addIssue(issues, path, 'non-float data must not declare quantity metadata.')
  }
  if (materialValue && descriptor?.errorRate !== undefined) {
    if (
      typeof descriptor.errorRate !== 'number' ||
      !Number.isFinite(descriptor.errorRate) ||
      descriptor.errorRate < 0 ||
      descriptor.errorRate >= 1
    ) {
      addIssue(issues, `${path}.errorRate`, 'must be a finite number in [0, 1).')
    }
  }

  const outerShape: number[] = []
  const actualAxes = descriptor?.axes
  if (spec.axes === undefined) {
    if (actualAxes !== undefined) addIssue(issues, `${path}.axes`, 'must be omitted.')
  } else if (!Array.isArray(actualAxes) || actualAxes.length !== spec.axes.length) {
    addIssue(issues, `${path}.axes`, `must contain ${spec.axes.length} axes.`)
    spec.axes.forEach((axis) => {
      if (axis.length !== undefined) outerShape.push(axis.length)
    })
  } else {
    spec.axes.forEach((axis, index) => {
      const actual = actualAxes[index]
      const axisPath = `${path}.axes[${index}]`
      if (!isRecord(actual)) {
        addIssue(issues, axisPath, 'must be an axis descriptor.')
        return
      }
      Reflect.ownKeys(actual).forEach((key) => {
        if (typeof key !== 'string' || !['length', 'name', 'ticks', 'unit', 'quantityKind'].includes(key)) {
          addIssue(issues, `${axisPath}.${String(key)}`, 'is not allowed.')
        }
      })
      const length = axis.length ?? actual.length
      if (
        !Number.isSafeInteger(length) ||
        (length as number) <= 0 ||
        (axis.length !== undefined && actual.length !== axis.length)
      ) {
        addIssue(
          issues,
          `${axisPath}.length`,
          axis.length === undefined ? 'must be a positive safe integer.' : `must be ${axis.length}.`,
        )
      } else {
        outerShape.push(length as number)
      }
      if (axis.quantityKind === undefined) {
        if (actual.quantityKind !== undefined || actual.unit !== undefined)
          addIssue(issues, axisPath, 'must be unitless.')
      } else if (actual.quantityKind !== axis.quantityKind) {
        addIssue(issues, `${axisPath}.quantityKind`, `must be ${axis.quantityKind}.`)
      } else {
        compatibleUnit(actual.unit, axis.unit, `${axisPath}.unit`, issues)
      }
      if (actual.ticks !== undefined && (!Array.isArray(actual.ticks) || actual.ticks.length !== length)) {
        addIssue(issues, `${axisPath}.ticks`, `must contain ${String(length)} entries.`)
      }
    })
  }

  const expectedShape = [...outerShape, ...Array.from({ length: tensorOrder }, () => 3)]
  const raw = descriptor ? descriptor.value : value
  const valuePath = descriptor ? `${path}.value` : path
  const leaves = dataLeaves(raw, expectedShape, valuePath, spec.dtype, issues)
  leaves.forEach((leaf) => {
    if (spec.dtype === 'string') {
      if (typeof leaf === 'string' && spec.minimumLength !== undefined && leaf.length < spec.minimumLength) {
        addIssue(issues, valuePath, `must contain strings of at least ${spec.minimumLength} characters.`)
      }
      if (typeof leaf === 'string' && spec.values && !spec.values.includes(leaf)) {
        addIssue(issues, valuePath, `must contain only ${spec.values.join(', ')}.`)
      }
      return
    }
    if (typeof leaf !== 'number' || !Number.isFinite(leaf)) return
    let comparable = leaf
    if (float && unitCompatible) {
      try {
        comparable = convertUcumValue(leaf, descriptor!.unit as string, spec.unit, path)
      } catch {
        return
      }
    }
    if (
      spec.minimum !== undefined &&
      (spec.exclusiveMinimum ? comparable <= spec.minimum : comparable < spec.minimum)
    ) {
      addIssue(issues, valuePath, `must be ${spec.exclusiveMinimum ? 'greater than' : 'at least'} ${spec.minimum}.`)
    }
    if (
      spec.maximum !== undefined &&
      (spec.exclusiveMaximum ? comparable >= spec.maximum : comparable > spec.maximum)
    ) {
      addIssue(issues, valuePath, `must be ${spec.exclusiveMaximum ? 'less than' : 'at most'} ${spec.maximum}.`)
    }
  })
}

function validateParameters(
  values: unknown,
  specs: Readonly<Record<string, { required?: boolean; data: KernelValueSpec }>>,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
  materialValues = false,
) {
  if (!isRecord(values)) {
    addIssue(issues, path, 'must be an object.')
    return
  }
  if (!materialValues) {
    Object.keys(values).forEach((name) => {
      if (!Object.prototype.hasOwnProperty.call(specs, name)) addIssue(issues, `${path}.${name}`, 'is not declared.')
    })
    Object.entries(specs).forEach(([name, spec]) => {
      if (!Object.prototype.hasOwnProperty.call(values, name) && spec.required !== false) {
        addIssue(issues, `${path}.${name}`, 'is required.')
      }
    })
  }
  Object.entries(values).forEach(([name, value]) => {
    const spec = specs[name]
    if (spec) validateValue(value, spec.data, `${path}.${name}`, catalog, issues, materialValues)
  })
}

function targetGroup(scene: CadScene, kind: 'geometry' | 'surface', name: string) {
  return (kind === 'geometry' ? scene.geometryGroups : scene.surfaceGroups).find((candidate) => candidate.name === name)
}

function resolvedTargetParts(scene: CadScene, kind: 'geometry' | 'surface', name: string): readonly CadScenePart[] {
  const group = targetGroup(scene, kind, name)
  if (!group) return []
  if (kind === 'geometry') {
    return group.geometryIds.flatMap((id) => {
      const part = scene.parts.find((candidate) => candidate.id === id)
      return part ? [part] : []
    })
  }
  return scene.parts.filter((part) => part.surfaces.some((surface) => group.surfaceIds.includes(surface.id)))
}

function validateCalls(
  descriptor: KernelDescriptor,
  category: (typeof methodCategories)[number],
  calls: unknown,
  scenes: Readonly<{ experiment: CadScene; task: CadScene }>,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
) {
  if (!Array.isArray(calls)) {
    addIssue(issues, path, 'must be an array.')
    return
  }
  const methods = descriptor.methods[category] as readonly (KernelMethodDescriptor | KernelOutputMethodDescriptor)[]
  const methodById = new Map(methods.map((method) => [method.methodId, method]))
  methods.forEach((method) => {
    const count = calls.filter((call) => isRecord(call) && call.methodId === method.methodId).length
    if (count < method.minimumOccurrences || count > method.maximumOccurrences) {
      addIssue(
        issues,
        path,
        `${method.methodId} must occur ${method.minimumOccurrences}..${method.maximumOccurrences} times; received ${count}.`,
      )
    }
  })
  const outputKeys = new Set<string>()
  calls.forEach((call, index) => {
    const callPath = `${path}[${index}]`
    if (!isRecord(call)) {
      addIssue(issues, callPath, 'must be a method call object.')
      return
    }
    const allowed =
      category === 'outputs' ? ['key', 'methodId', 'target', 'parameters'] : ['methodId', 'target', 'parameters']
    Reflect.ownKeys(call).forEach((key) => {
      if (typeof key !== 'string' || !allowed.includes(key))
        addIssue(issues, `${callPath}.${String(key)}`, 'is not allowed.')
    })
    if (category === 'outputs') {
      if (typeof call.key !== 'string' || !call.key.trim()) {
        addIssue(issues, `${callPath}.key`, 'must be a non-empty string.')
      } else if (outputKeys.has(call.key)) {
        addIssue(issues, `${callPath}.key`, `${call.key} is duplicated within this Task.`)
      } else {
        outputKeys.add(call.key)
      }
    }
    const method = typeof call.methodId === 'string' ? methodById.get(call.methodId) : undefined
    if (!method) {
      addIssue(issues, `${callPath}.methodId`, 'is not declared for this method category.')
      return
    }
    validateParameters(call.parameters, method.parameters, `${callPath}.parameters`, catalog, issues)
    if (!Array.isArray(call.target)) {
      addIssue(issues, `${callPath}.target`, 'must be an array.')
      return
    }
    if (call.target.length < method.target.minimumTargets || call.target.length > method.target.maximumTargets) {
      addIssue(
        issues,
        `${callPath}.target`,
        `must contain ${method.target.minimumTargets}..${method.target.maximumTargets} targets.`,
      )
    }
    if (new Set(call.target).size !== call.target.length)
      addIssue(issues, `${callPath}.target`, 'must not contain duplicates.')
    let resolvedCount = 0
    call.target.forEach((target, targetIndex) => {
      const targetPath = `${callPath}.target[${targetIndex}]`
      const prefix = `${method.target.source}.${method.target.kind}.`
      if (typeof target !== 'string' || !target.startsWith(prefix) || !target.slice(prefix.length)) {
        addIssue(issues, targetPath, `must match ${prefix}<group>.`)
        return
      }
      const scene = scenes[method.target.source]
      const group = targetGroup(scene, method.target.kind, target.slice(prefix.length))
      if (!group) {
        addIssue(issues, targetPath, 'references a group that is not declared in its scene.')
        return
      }
      if (group.missingMemberIds.length > 0) {
        addIssue(issues, targetPath, `references unresolved members: ${group.missingMemberIds.join(', ')}.`)
      }
      resolvedCount += method.target.kind === 'geometry' ? group.geometryIds.length : group.surfaceIds.length
    })
    if (resolvedCount < method.target.minimumResolved || resolvedCount > method.target.maximumResolved) {
      addIssue(
        issues,
        `${callPath}.target`,
        `must resolve to ${method.target.minimumResolved}..${method.target.maximumResolved} members; resolved ${resolvedCount}.`,
      )
    }
  })
}

function validateMaterials(
  descriptor: KernelDescriptor,
  config: Readonly<Record<string, unknown>>,
  scenes: Readonly<{ experiment: CadScene; task: CadScene }>,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
) {
  descriptor.materials.forEach((material) => {
    const calls = config[material.target.category]
    if (!Array.isArray(calls)) return
    calls.forEach((call, callIndex) => {
      if (!isRecord(call) || call.methodId !== material.target.methodId || !Array.isArray(call.target)) return
      call.target.forEach((target) => {
        if (typeof target !== 'string') return
        const match = /^(experiment|task)\.(geometry|surface)\.(.+)$/u.exec(target)
        if (!match) return
        const source = match[1] as 'experiment' | 'task'
        const kind = match[2] as 'geometry' | 'surface'
        resolvedTargetParts(scenes[source], kind, match[3]).forEach((part) => {
          if (!part.material) return
          validateParameters(
            part.material.variables,
            material.properties,
            `${path}.${material.target.category}[${callIndex}].material[${JSON.stringify(part.id)}]`,
            catalog,
            issues,
            true,
          )
        })
      })
    })
  })
}

function validateMaterialParameter(
  value: unknown,
  quantityKindName: string,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be a MaterialParameter value descriptor.')
    return
  }
  const allowed = new Set(['dtype', 'unit', 'quantityKind', 'errorRate', 'basis', 'value'])
  Reflect.ownKeys(value).forEach((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) addIssue(issues, `${path}.${String(key)}`, 'is not allowed.')
  })
  if (value.dtype !== 'float16' && value.dtype !== 'float32' && value.dtype !== 'float64') {
    addIssue(issues, `${path}.dtype`, 'must be float16, float32, or float64.')
    return
  }
  if (value.quantityKind !== quantityKindName) addIssue(issues, `${path}.quantityKind`, `must be ${quantityKindName}.`)
  const kind = quantityKind(catalog, quantityKindName)
  if (!kind) {
    addIssue(issues, `${path}.quantityKind`, 'is not in the active Catalog slice.')
    return
  }
  compatibleUnit(value.unit, kind.applicableUnits[0], `${path}.unit`, issues)
  if (kind.tensorOrder === 0 && value.basis !== undefined)
    addIssue(issues, `${path}.basis`, 'is forbidden for a scalar QuantityKind.')
  if (kind.tensorOrder > 0 && value.basis !== undefined) validateBasis(value.basis, `${path}.basis`, issues)
  dataLeaves(
    value.value,
    Array.from({ length: kind.tensorOrder }, () => 3),
    `${path}.value`,
    value.dtype,
    issues,
  )
  if (
    typeof value.errorRate !== 'number' ||
    !Number.isFinite(value.errorRate) ||
    value.errorRate < 0 ||
    value.errorRate >= 1
  ) {
    addIssue(issues, `${path}.errorRate`, 'must be a finite number in [0, 1).')
  }
}

function validateMaterialSeries(
  value: unknown,
  quantityKindName: string,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be a quantity series.')
    return undefined
  }
  Reflect.ownKeys(value).forEach((key) => {
    if (typeof key !== 'string' || !['unit', 'values', 'basis'].includes(key)) {
      addIssue(issues, `${path}.${String(key)}`, 'is not allowed.')
    }
  })
  const kind = quantityKind(catalog, quantityKindName)
  if (!kind) {
    addIssue(issues, `${path}.quantityKind`, `${quantityKindName} is not in the active Catalog slice.`)
    return undefined
  }
  compatibleUnit(value.unit, kind.applicableUnits[0], `${path}.unit`, issues)
  if (kind.tensorOrder === 0 && value.basis !== undefined)
    addIssue(issues, `${path}.basis`, 'is forbidden for a scalar QuantityKind.')
  if (kind.tensorOrder > 0 && value.basis !== undefined) validateBasis(value.basis, `${path}.basis`, issues)
  if (!Array.isArray(value.values)) {
    addIssue(issues, `${path}.values`, 'must be an array.')
    return undefined
  }
  value.values.forEach((sample, index) => {
    dataLeaves(
      sample,
      Array.from({ length: kind.tensorOrder }, () => 3),
      `${path}.values[${index}]`,
      'float64',
      issues,
    )
  })
  return value
}

function validateMaterialModel(
  value: unknown,
  model: CatalogRuntimeSlice['materialModels'][number],
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be a sampled_relation Material model.')
    return
  }
  Reflect.ownKeys(value).forEach((key) => {
    if (typeof key !== 'string' || !['kind', 'input', 'output'].includes(key)) {
      addIssue(issues, `${path}.${String(key)}`, 'is not allowed.')
    }
  })
  if (value.kind !== 'sampled_relation') addIssue(issues, `${path}.kind`, 'must be sampled_relation.')
  const input = validateMaterialSeries(value.input, model.input.quantityKind, `${path}.input`, catalog, issues)
  const output = validateMaterialSeries(value.output, model.output.quantityKind, `${path}.output`, catalog, issues)
  if (!input || !output || !Array.isArray(input.values) || !Array.isArray(output.values)) return
  if (input.values.length < model.minimumSamples) {
    addIssue(issues, `${path}.input.values`, `must contain at least ${model.minimumSamples} samples.`)
  }
  if (input.values.length !== output.values.length) {
    addIssue(issues, path, 'input and output must contain the same number of samples.')
  }
  if (model.sharedBasis && JSON.stringify(input.basis) !== JSON.stringify(output.basis)) {
    addIssue(issues, path, 'input and output must use the same Cartesian basis.')
  }
}

function validateSceneMaterials(
  scene: CadScene,
  path: string,
  catalog: CatalogRuntimeSlice,
  checked: Set<object>,
  issues: KernelContractIssue[],
) {
  scene.parts.forEach((part) => {
    if (!part.material || checked.has(part.material)) return
    checked.add(part.material)
    const materialPath = `${path}.material[${JSON.stringify(part.id)}]`
    if (!part.material.name.trim()) addIssue(issues, `${materialPath}.name`, 'must be a non-empty string.')
    if (
      typeof part.material.errorRate !== 'number' ||
      !Number.isFinite(part.material.errorRate) ||
      part.material.errorRate < 0 ||
      part.material.errorRate >= 1
    ) {
      addIssue(issues, `${materialPath}.errorRate`, 'must be a finite number in [0, 1).')
    }
    Object.entries(part.material.variables).forEach(([key, value]) => {
      if (key === 'color') {
        if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
          addIssue(issues, `${materialPath}.variables.color`, 'must use #RRGGBB format.')
        }
        return
      }
      const parameter = catalog.materialParameters.find((candidate) => candidate.key === key)
      if (parameter) {
        validateMaterialParameter(
          value,
          parameter.quantityKind,
          `${materialPath}.variables[${JSON.stringify(key)}]`,
          catalog,
          issues,
        )
        return
      }
      const model = catalog.materialModels.find((candidate) => candidate.key === key)
      if (model) {
        validateMaterialModel(value, model, `${materialPath}.variables[${JSON.stringify(key)}]`, catalog, issues)
        return
      }
      addIssue(
        issues,
        `${materialPath}.variables[${JSON.stringify(key)}]`,
        'is not a MaterialParameter or MaterialModel in the active Catalog slice.',
      )
    })
  })
}

function validateRecordedSchema(
  node: unknown,
  path: string,
  catalog: CatalogRuntimeSlice,
  issues: KernelContractIssue[],
  nested: boolean,
) {
  if (!isRecord(node)) {
    addIssue(issues, path, 'must be a tensor descriptor or group.')
    return
  }
  if (!Object.prototype.hasOwnProperty.call(node, 'dtype')) {
    if (Object.keys(node).length === 0 && nested) addIssue(issues, path, 'must not be an empty group.')
    Object.entries(node).forEach(([name, member]) => {
      if (!recordedDataNamePattern.test(name)) addIssue(issues, `${path}.${name}`, 'uses an invalid RecordedData name.')
      validateRecordedSchema(member, `${path}.${name}`, catalog, issues, true)
    })
    return
  }
  const allowed = new Set(['dtype', 'tensorOrder', 'axes', 'unit', 'quantityKind', 'basis'])
  Reflect.ownKeys(node).forEach((key) => {
    if (typeof key !== 'string' || !allowed.has(key))
      addIssue(issues, `${path}.${String(key)}`, 'is not a RecordedData descriptor field.')
  })
  if (typeof node.dtype !== 'string' || !dataDTypes.has(node.dtype)) {
    addIssue(issues, `${path}.dtype`, 'is not supported.')
    return
  }
  const float = node.dtype.startsWith('float')
  if (float) {
    const kind = quantityKind(catalog, node.quantityKind)
    if (!kind) {
      addIssue(issues, `${path}.quantityKind`, 'must name a QuantityKind in the active Catalog slice.')
    } else {
      const unit = kind.applicableUnits.find((candidate) => {
        try {
          convertUcumValue(1, node.unit as string, candidate, path)
          return true
        } catch {
          return false
        }
      })
      if (!unit) addIssue(issues, `${path}.unit`, `must be compatible with ${kind.name}.`)
      if (kind.tensorOrder === 0 && node.basis !== undefined)
        addIssue(issues, `${path}.basis`, 'is forbidden for a scalar Quantity Kind.')
      if (kind.tensorOrder > 0 && node.basis !== undefined) validateBasis(node.basis, `${path}.basis`, issues)
    }
  } else {
    if (node.unit !== undefined || node.quantityKind !== undefined || node.basis !== undefined) {
      addIssue(issues, path, 'non-float data must not declare quantity metadata.')
    }
  }
  if (node.axes !== undefined) {
    if (!Array.isArray(node.axes) || node.axes.length === 0) {
      addIssue(issues, `${path}.axes`, 'must be a non-empty array when present.')
    } else {
      node.axes.forEach((axis, index) => {
        const axisPath = `${path}.axes[${index}]`
        if (!isRecord(axis)) {
          addIssue(issues, axisPath, 'must be an axis descriptor.')
          return
        }
        Reflect.ownKeys(axis).forEach((key) => {
          if (typeof key !== 'string' || !['length', 'name', 'ticks', 'unit', 'quantityKind'].includes(key)) {
            addIssue(issues, `${axisPath}.${String(key)}`, 'is not allowed.')
          }
        })
        if (axis.length !== undefined && (!Number.isSafeInteger(axis.length) || (axis.length as number) <= 0)) {
          addIssue(issues, `${axisPath}.length`, 'must be a positive safe integer.')
        }
        if (axis.name !== undefined && (typeof axis.name !== 'string' || !axis.name.trim()))
          addIssue(issues, `${axisPath}.name`, 'must be a non-empty string.')
        if (axis.ticks !== undefined) {
          if (!Array.isArray(axis.ticks) || axis.length === undefined || axis.ticks.length !== axis.length) {
            addIssue(issues, `${axisPath}.ticks`, 'must match the fixed axis length.')
          } else if (
            axis.ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))
          ) {
            addIssue(issues, `${axisPath}.ticks`, 'must contain only finite numbers or strings.')
          }
        }
        if ((axis.unit === undefined) !== (axis.quantityKind === undefined)) {
          addIssue(issues, axisPath, 'must declare unit and quantityKind together.')
        } else if (axis.quantityKind !== undefined) {
          const kind = quantityKind(catalog, axis.quantityKind)
          if (!kind || kind.tensorOrder !== 0)
            addIssue(issues, `${axisPath}.quantityKind`, 'must name a scalar QuantityKind in the active Catalog slice.')
          else compatibleUnit(axis.unit, kind.applicableUnits[0], `${axisPath}.unit`, issues)
        }
      })
    }
  }
}

function validateRayPaths(recordedData: Readonly<Record<string, unknown>>, issues: KernelContractIssue[]) {
  const rayPaths = recordedData.rayPaths
  if (rayPaths === undefined) return
  if (!isRecord(rayPaths) || Object.prototype.hasOwnProperty.call(rayPaths, 'dtype')) {
    addIssue(issues, 'recordedData.rayPaths', 'must be the reserved ray-path group.')
    return
  }
  const expected = Object.freeze({
    vertices: ['float32', 2, 'Length', 'm'],
    pathOffsets: ['uint32', 1, undefined, undefined],
    segmentPower: ['float32', 1, 'optics.RadiantFlux', 'W'],
    pathWavelength: ['float32', 1, 'Wavelength', 'm'],
    segmentEvent: ['uint8', 1, undefined, undefined],
  } as const)
  Object.keys(rayPaths).forEach((name) => {
    if (!Object.prototype.hasOwnProperty.call(expected, name))
      addIssue(issues, `recordedData.rayPaths.${name}`, 'is not a reserved ray-path member.')
  })
  Object.entries(expected).forEach(([name, [dtype, rank, quantityKindName, unit]]) => {
    const member = rayPaths[name]
    const path = `recordedData.rayPaths.${name}`
    if (!isRecord(member) || member.dtype !== dtype || !Array.isArray(member.axes) || member.axes.length !== rank) {
      addIssue(issues, path, `must be a rank-${rank} ${dtype} tensor descriptor.`)
      return
    }
    if (quantityKindName === undefined) {
      if (member.quantityKind !== undefined || member.unit !== undefined || member.basis !== undefined) {
        addIssue(issues, path, 'must not declare quantity metadata.')
      }
    } else {
      if (member.quantityKind !== quantityKindName)
        addIssue(issues, `${path}.quantityKind`, `must be ${quantityKindName}.`)
      compatibleUnit(member.unit, unit, `${path}.unit`, issues)
    }
  })
  const vertices = rayPaths.vertices
  if (isRecord(vertices) && Array.isArray(vertices.axes)) {
    const componentAxis = vertices.axes[1]
    if (!isRecord(componentAxis) || componentAxis.length !== 3) {
      addIssue(issues, 'recordedData.rayPaths.vertices.axes[1].length', 'must be 3.')
    }
  }
}

export function assertExperimentAuthoringSemantics(
  catalog: CatalogRuntimeSlice,
  evaluated: EvaluatedRuntimeDocumentSnapshot,
) {
  const issues: KernelContractIssue[] = []
  validateRecordedSchema(evaluated.simulationProgram.recordedData, 'recordedData', catalog, issues, false)
  validateRayPaths(evaluated.simulationProgram.recordedData, issues)
  const checkedMaterials = new Set<object>()
  validateSceneMaterials(evaluated.scene, 'experiment.geometry', catalog, checkedMaterials, issues)
  Object.entries(evaluated.taskScenes).forEach(([taskName, scene]) => {
    validateSceneMaterials(scene, `tasks[${JSON.stringify(taskName)}].geometry`, catalog, checkedMaterials, issues)
  })
  Object.entries(evaluated.simulationProgram.tasks).forEach(([taskName, task]) => {
    const kernelPath = `tasks[${JSON.stringify(taskName)}].kernel`
    if (!isRecord(task.kernel)) {
      addIssue(issues, kernelPath, 'must contain exactly name and version.')
      return
    }
    Reflect.ownKeys(task.kernel).forEach((key) => {
      if (typeof key !== 'string' || !['name', 'version'].includes(key)) {
        addIssue(issues, `${kernelPath}.${String(key)}`, 'is not allowed.')
      }
    })
    if (typeof task.kernel.name !== 'string' || !task.kernel.name.trim()) {
      addIssue(issues, `${kernelPath}.name`, 'must be a non-empty string.')
    }
    if (typeof task.kernel.version !== 'string' || !task.kernel.version.trim()) {
      addIssue(issues, `${kernelPath}.version`, 'must be a non-empty string.')
    }
    if (task.kernel.name === DRAFT_TASK_KERNEL.name && task.kernel.version === DRAFT_TASK_KERNEL.version) return
    const path = `tasks[${JSON.stringify(taskName)}].config`
    const solver = catalog.solvers.find(
      (candidate) => candidate.name === task.kernel.name && candidate.version === task.kernel.version,
    )
    if (!solver) {
      addIssue(
        issues,
        kernelPath,
        `${task.kernel.name}@${task.kernel.version} is not in the active Catalog slice.`,
      )
      return
    }
    const scene = evaluated.taskScenes[taskName]
    if (!scene) {
      addIssue(issues, `tasks[${JSON.stringify(taskName)}]`, 'has no evaluated Task scene.')
      return
    }
    if (!isRecord(task.config)) {
      addIssue(issues, path, 'must be an object.')
      return
    }
    const config = task.config
    const allowed = new Set(['parameters', ...methodCategories])
    Reflect.ownKeys(config).forEach((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) addIssue(issues, `${path}.${String(key)}`, 'is not allowed.')
    })
    validateParameters(config.parameters, solver.descriptor.parameters, `${path}.parameters`, catalog, issues)
    const scenes = Object.freeze({ experiment: evaluated.scene, task: scene })
    methodCategories.forEach((category) => {
      validateCalls(solver.descriptor, category, config[category], scenes, `${path}.${category}`, catalog, issues)
    })
    if (Array.isArray(config.outputs) && config.outputs.length < (solver.descriptor.minimumOutputs ?? 0)) {
      addIssue(
        issues,
        `${path}.outputs`,
        `must contain at least ${solver.descriptor.minimumOutputs ?? 0} output requests.`,
      )
    }
    validateMaterials(solver.descriptor, config, scenes, path, catalog, issues)
  })
  if (issues.length > 0) {
    throw new CadModelError(
      `Experiment source is invalid:\n${issues.map((issue) => `- ${issue.path} ${issue.message}`).join('\n')}`,
    )
  }
}
