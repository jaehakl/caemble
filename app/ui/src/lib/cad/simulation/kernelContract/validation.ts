import type { CadScene, CadScenePart } from '../../evaluation/types'
import {
  CadModelError,
  isFloatDType,
  normalizeDataElement,
  type DataValueDescriptor,
  type ExperimentParameter,
} from '../../model/core'
import { convertUcumValue, normalizeUcumUnit } from '../../model/units'
import { QuantityKind } from '../../../quantitykind'
import {
  getQuantityKindComponentShape,
  getQuantityKindTensorOrder,
  normalizeCartesianBasis,
  transformQuantityValue,
  type QuantityKindName,
} from '../../../quantitykind/runtime'
import type {
  KernelContractIssue,
  KernelDescriptor,
  KernelInputPortDescriptor,
  KernelMethodCall,
  KernelMethodDescriptor,
  KernelOutputMethodDescriptor,
  KernelTaskConfig,
  KernelValueSpec,
  KernelWorld,
  ResolvedKernelOutputSpec,
} from './types'

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
const artifactTypePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*@[1-9][0-9]*$/

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

function assertCardinality(minimum: unknown, maximum: unknown, path: string, issues: KernelContractIssue[]) {
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    (minimum as number) < 0 ||
    (maximum as number) < (minimum as number)
  ) {
    addIssue(issues, path, 'must use safe integer bounds with 0 <= minimum <= maximum.')
  }
}

function validateDataSpec(spec: unknown, path: string, issues: KernelContractIssue[], allowDynamicAxes: boolean) {
  if (!isRecord(spec)) {
    addIssue(issues, path, 'must be a data schema.')
    return
  }
  if (typeof spec.dtype !== 'string' || !dataDTypes.has(spec.dtype)) {
    addIssue(issues, `${path}.dtype`, 'is not supported.')
    return
  }
  if (spec.axes !== undefined) {
    if (!Array.isArray(spec.axes) || spec.axes.length === 0) {
      addIssue(issues, `${path}.axes`, 'must be a non-empty array when present.')
    } else {
      spec.axes.forEach((axis, index) => {
        const axisPath = `${path}.axes[${index}]`
        if (!isRecord(axis)) {
          addIssue(issues, axisPath, 'must be an axis schema.')
          return
        }
        if (
          axis.length === undefined
            ? !allowDynamicAxes
            : !Number.isSafeInteger(axis.length) || (axis.length as number) <= 0
        ) {
          addIssue(
            issues,
            `${axisPath}.length`,
            allowDynamicAxes ? 'must be a positive safe integer when present.' : 'must be a positive safe integer.',
          )
        }
        if (axis.ticks !== undefined) {
          if (!Array.isArray(axis.ticks)) {
            addIssue(issues, `${axisPath}.ticks`, 'must be an array.')
          } else {
            if (axis.length === undefined || axis.ticks.length !== axis.length) {
              addIssue(issues, `${axisPath}.ticks`, 'must match the fixed axis length.')
            }
            axis.ticks.forEach((tick, tickIndex) => {
              if (typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick))) {
                addIssue(issues, `${axisPath}.ticks[${tickIndex}]`, 'must be a finite number or string.')
              }
            })
          }
        }
        const hasQuantity = axis.quantityKind !== undefined || axis.unit !== undefined
        if (hasQuantity && (typeof axis.quantityKind !== 'string' || typeof axis.unit !== 'string')) {
          addIssue(issues, axisPath, 'must declare both quantityKind and unit.')
        }
        if (typeof axis.quantityKind === 'string') {
          validateQuantityMetadata(axis.quantityKind, axis.unit, undefined, axisPath, issues, true)
        }
      })
    }
  }

  if (isFloatDType(spec.dtype as never)) {
    if (typeof spec.quantityKind !== 'string' || typeof spec.unit !== 'string') {
      addIssue(issues, path, 'float data must declare quantityKind and unit.')
    } else {
      validateQuantityMetadata(spec.quantityKind, spec.unit, spec.basis, path, issues, false)
    }
  } else if (spec.quantityKind !== undefined || spec.unit !== undefined || spec.basis !== undefined) {
    addIssue(issues, path, 'non-float data must not declare quantity metadata.')
  }

  const bounds = spec as Readonly<{
    minimum?: unknown
    maximum?: unknown
    exclusiveMinimum?: unknown
    exclusiveMaximum?: unknown
  }>
  if (bounds.minimum !== undefined && (typeof bounds.minimum !== 'number' || !Number.isFinite(bounds.minimum))) {
    addIssue(issues, `${path}.minimum`, 'must be finite.')
  }
  if (bounds.maximum !== undefined && (typeof bounds.maximum !== 'number' || !Number.isFinite(bounds.maximum))) {
    addIssue(issues, `${path}.maximum`, 'must be finite.')
  }
  if (typeof bounds.minimum === 'number' && typeof bounds.maximum === 'number' && bounds.minimum > bounds.maximum) {
    addIssue(issues, path, 'minimum must not exceed maximum.')
  }
  if (bounds.exclusiveMinimum !== undefined && bounds.minimum === undefined) {
    addIssue(issues, `${path}.exclusiveMinimum`, 'requires minimum.')
  }
  if (bounds.exclusiveMaximum !== undefined && bounds.maximum === undefined) {
    addIssue(issues, `${path}.exclusiveMaximum`, 'requires maximum.')
  }
}

function validateQuantityMetadata(
  quantityKind: string,
  unit: unknown,
  basis: unknown,
  path: string,
  issues: KernelContractIssue[],
  scalarOnly: boolean,
) {
  if (!Object.prototype.hasOwnProperty.call(QuantityKind, quantityKind)) {
    addIssue(issues, `${path}.quantityKind`, 'must be a known Quantity Kind.')
    return
  }
  let normalizedUnit: string
  try {
    normalizedUnit = normalizeUcumUnit(unit, `${path}.unit`)
  } catch (error) {
    addIssue(issues, `${path}.unit`, error instanceof Error ? error.message : 'must be valid UCUM.')
    return
  }
  const entry = QuantityKind[quantityKind as QuantityKindName]
  const applicableUnits = entry.applicableUnits() as readonly string[]
  if (!applicableUnits.includes(normalizedUnit)) {
    addIssue(issues, `${path}.unit`, `${normalizedUnit} is not applicable to ${quantityKind}.`)
  }
  const tensorOrder = entry.tensorOrder()
  if (scalarOnly && tensorOrder !== 0) {
    addIssue(issues, `${path}.quantityKind`, 'must have tensor order 0.')
  }
  if (tensorOrder === 0 && basis !== undefined) {
    addIssue(issues, `${path}.basis`, 'is forbidden for a scalar Quantity Kind.')
  }
  if (tensorOrder > 0) {
    try {
      normalizeCartesianBasis(basis, `${path}.basis`)
    } catch (error) {
      addIssue(issues, `${path}.basis`, error instanceof Error ? error.message : 'must be valid.')
    }
  }
}

function validateParametersDescriptor(parameters: unknown, path: string, issues: KernelContractIssue[]) {
  if (!isRecord(parameters)) {
    addIssue(issues, path, 'must be an object.')
    return
  }
  Object.entries(parameters).forEach(([name, parameter]) => {
    const parameterPath = `${path}.${name}`
    if (!name.trim() || !isRecord(parameter)) {
      addIssue(issues, parameterPath, 'must be a named parameter descriptor.')
      return
    }
    if (typeof parameter.description !== 'string' || !parameter.description.trim()) {
      addIssue(issues, `${parameterPath}.description`, 'must be a non-empty string.')
    }
    if (parameter.required !== undefined && typeof parameter.required !== 'boolean') {
      addIssue(issues, `${parameterPath}.required`, 'must be boolean.')
    }
    validateDataSpec(parameter.data, `${parameterPath}.data`, issues, false)
  })
}

function validateTargetDescriptor(target: unknown, path: string, issues: KernelContractIssue[]) {
  if (!isRecord(target)) {
    addIssue(issues, path, 'must be a target descriptor.')
    return
  }
  if (target.source !== 'structure' && target.source !== 'experiment') {
    addIssue(issues, `${path}.source`, 'must be structure or experiment.')
  }
  if (target.kind !== 'geometry' && target.kind !== 'surface') {
    addIssue(issues, `${path}.kind`, 'must be geometry or surface.')
  }
  assertCardinality(target.minimumTargets, target.maximumTargets, path, issues)
  assertCardinality(target.minimumResolved, target.maximumResolved, `${path}.resolved`, issues)
}

function validateMethods(
  methods: unknown,
  category: 'initializations' | 'boundaryConditions' | 'outputs',
  issues: KernelContractIssue[],
  methodIds: Set<string>,
) {
  const path = `descriptor.methods.${category}`
  if (!Array.isArray(methods)) {
    addIssue(issues, path, 'must be an array.')
    return
  }
  methods.forEach((method, index) => {
    const methodPath = `${path}[${index}]`
    if (!isRecord(method)) {
      addIssue(issues, methodPath, 'must be a method descriptor.')
      return
    }
    if (typeof method.methodId !== 'string' || !method.methodId.trim()) {
      addIssue(issues, `${methodPath}.methodId`, 'must be a non-empty string.')
    } else if (methodIds.has(method.methodId)) {
      addIssue(issues, `${methodPath}.methodId`, `${method.methodId} is duplicated across the descriptor.`)
    } else {
      methodIds.add(method.methodId)
    }
    if (typeof method.description !== 'string' || !method.description.trim()) {
      addIssue(issues, `${methodPath}.description`, 'must be a non-empty string.')
    }
    assertCardinality(method.minimumOccurrences, method.maximumOccurrences, `${methodPath}.occurrences`, issues)
    validateTargetDescriptor(method.target, `${methodPath}.target`, issues)
    validateParametersDescriptor(method.parameters, `${methodPath}.parameters`, issues)
    if (category === 'outputs') {
      if (typeof method.artifactType !== 'string' || !artifactTypePattern.test(method.artifactType)) {
        addIssue(
          issues,
          `${methodPath}.artifactType`,
          'must be a versioned artifact type ending in @<positive integer>.',
        )
      }
      validateDataSpec(method.data, `${methodPath}.data`, issues, true)
    } else if (method.artifactType !== undefined || method.data !== undefined || method.result !== undefined) {
      addIssue(issues, methodPath, 'initialization and boundary-condition methods cannot declare results.')
    }
  })
}

export function validateKernelDescriptor(descriptor: KernelDescriptor): readonly KernelContractIssue[] {
  const issues: KernelContractIssue[] = []
  if (!isRecord(descriptor)) return [Object.freeze({ path: 'descriptor', message: 'must be an object.' })]
  if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) {
    addIssue(issues, 'descriptor.name', 'must be a non-empty string.')
  }
  if (typeof descriptor.version !== 'string' || !descriptor.version.trim()) {
    addIssue(issues, 'descriptor.version', 'must be a non-empty string.')
  }
  if (typeof descriptor.description !== 'string' || !descriptor.description.trim()) {
    addIssue(issues, 'descriptor.description', 'must be a non-empty string.')
  }
  try {
    normalizeUcumUnit(descriptor.referenceLengthUnit, 'descriptor.referenceLengthUnit')
  } catch (error) {
    addIssue(issues, 'descriptor.referenceLengthUnit', error instanceof Error ? error.message : 'must be valid UCUM.')
  }
  if (
    descriptor.minimumOutputs !== undefined &&
    (!Number.isSafeInteger(descriptor.minimumOutputs) || descriptor.minimumOutputs < 0)
  ) {
    addIssue(issues, 'descriptor.minimumOutputs', 'must be a non-negative safe integer.')
  }
  validateParametersDescriptor(descriptor.parameters, 'descriptor.parameters', issues)

  const methodIds = new Set<string>()
  if (!isRecord(descriptor.methods)) {
    addIssue(issues, 'descriptor.methods', 'must be an object.')
  } else {
    validateMethods(descriptor.methods.initializations, 'initializations', issues, methodIds)
    validateMethods(descriptor.methods.boundaryConditions, 'boundaryConditions', issues, methodIds)
    validateMethods(descriptor.methods.outputs, 'outputs', issues, methodIds)
  }

  if (!Array.isArray(descriptor.materials)) {
    addIssue(issues, 'descriptor.materials', 'must be an array.')
  } else {
    const roles = new Set<string>()
    descriptor.materials.forEach((material, index) => {
      const path = `descriptor.materials[${index}]`
      if (!isRecord(material)) {
        addIssue(issues, path, 'must be a material descriptor.')
        return
      }
      if (typeof material.role !== 'string' || !material.role.trim() || roles.has(material.role)) {
        addIssue(issues, `${path}.role`, 'must be a unique non-empty string.')
      } else {
        roles.add(material.role)
      }
      if (!isRecord(material.target)) {
        addIssue(issues, `${path}.target`, 'must identify a method.')
      } else {
        const category = material.target.category
        const methodId = material.target.methodId
        if (category !== 'initializations' && category !== 'boundaryConditions' && category !== 'outputs') {
          addIssue(issues, `${path}.target.category`, 'is invalid.')
        } else if (
          typeof methodId !== 'string' ||
          !(
            isRecord(descriptor.methods) &&
            Array.isArray(descriptor.methods[category]) &&
            descriptor.methods[category].some((method) => method.methodId === methodId)
          )
        ) {
          addIssue(issues, `${path}.target.methodId`, 'must reference a method in its category.')
        }
      }
      validateParametersDescriptor(material.properties, `${path}.properties`, issues)
    })
  }

  if (!isRecord(descriptor.inputPorts)) {
    addIssue(issues, 'descriptor.inputPorts', 'must be an object.')
  } else {
    Object.entries(descriptor.inputPorts).forEach(([name, port]) => {
      const path = `descriptor.inputPorts.${name}`
      if (!isRecord(port)) {
        addIssue(issues, path, 'must be an input-port descriptor.')
        return
      }
      if (!Array.isArray(port.artifactTypes) || port.artifactTypes.length === 0) {
        addIssue(issues, `${path}.artifactTypes`, 'must contain at least one artifact type.')
      } else {
        port.artifactTypes.forEach((artifactType, index) => {
          if (typeof artifactType !== 'string' || !artifactTypePattern.test(artifactType)) {
            addIssue(issues, `${path}.artifactTypes[${index}]`, 'must be a versioned artifact type.')
          }
        })
        if (new Set(port.artifactTypes).size !== port.artifactTypes.length) {
          addIssue(issues, `${path}.artifactTypes`, 'must not contain duplicates.')
        }
      }
      assertCardinality(port.minimumOccurrences, port.maximumOccurrences, `${path}.occurrences`, issues)
      if (port.data !== undefined) validateDataSpec(port.data, `${path}.data`, issues, true)
    })
  }

  if (!isRecord(descriptor.observations)) {
    addIssue(issues, 'descriptor.observations', 'must be an object.')
  } else {
    Object.entries(descriptor.observations).forEach(([name, observation]) => {
      const path = `descriptor.observations.${name}`
      if (!isRecord(observation) || !['number', 'boolean', 'string'].includes(observation.type as string)) {
        addIssue(issues, path, 'must declare number, boolean, or string type.')
      }
      if (isRecord(observation) && observation.required !== undefined && typeof observation.required !== 'boolean') {
        addIssue(issues, `${path}.required`, 'must be boolean.')
      }
    })
  }
  return Object.freeze(issues)
}

function throwIssues(subject: string, issues: readonly KernelContractIssue[]) {
  if (issues.length === 0) return
  throw new CadModelError(
    `${subject} is invalid:\n${issues.map((issue) => `- ${issue.path} ${issue.message}`).join('\n')}`,
  )
}

export function assertValidKernelDescriptor(descriptor: KernelDescriptor) {
  throwIssues(`Kernel descriptor ${descriptor.name || '<unnamed>'}`, validateKernelDescriptor(descriptor))
}

function methodsFor(descriptor: KernelDescriptor, category: 'initializations' | 'boundaryConditions' | 'outputs') {
  return descriptor.methods[category] as readonly (KernelMethodDescriptor | KernelOutputMethodDescriptor)[]
}

function sceneForTarget(world: KernelWorld, source: 'structure' | 'experiment') {
  return world.scenes[source]
}

function resolvedTargetParts(
  scene: CadScene,
  kind: 'geometry' | 'surface',
  groupName: string,
): readonly CadScenePart[] {
  if (kind === 'geometry') {
    const group = scene.geometryGroups.find((candidate) => candidate.name === groupName)
    if (!group) return []
    return group.geometryIds.flatMap((id) => {
      const part = scene.parts.find((candidate) => candidate.id === id)
      return part ? [part] : []
    })
  }
  const group = scene.surfaceGroups.find((candidate) => candidate.name === groupName)
  if (!group) return []
  return scene.parts.filter((part) => part.surfaces.some((surface) => group.surfaceIds.includes(surface.id)))
}

function resolvedTargetCount(scene: CadScene, kind: 'geometry' | 'surface', groupName: string) {
  if (kind === 'geometry') {
    const group = scene.geometryGroups.find((candidate) => candidate.name === groupName)
    return group?.geometryIds.filter((id) => scene.parts.some((part) => part.id === id)).length ?? 0
  }
  const group = scene.surfaceGroups.find((candidate) => candidate.name === groupName)
  return (
    group?.surfaceIds.filter((id) => scene.parts.some((part) => part.surfaces.some((surface) => surface.id === id)))
      .length ?? 0
  )
}

function validateValueShape(value: unknown, spec: KernelValueSpec, path: string, issues: KernelContractIssue[]) {
  const descriptor = isRecord(value) ? value : undefined
  if (spec.axes !== undefined && !descriptor) {
    addIssue(issues, path, 'must be a dtype descriptor with axes.')
    return
  }
  if (isFloatDType(spec.dtype)) {
    if (!descriptor) {
      addIssue(issues, path, 'must be an explicit float dtype descriptor.')
      return
    }
    if (
      descriptor.dtype !== spec.dtype ||
      descriptor.quantityKind !== spec.quantityKind ||
      typeof descriptor.unit !== 'string'
    ) {
      addIssue(issues, path, `must use ${spec.dtype}, ${spec.quantityKind}, and a compatible unit.`)
      return
    }
    try {
      convertUcumValue(1, descriptor.unit, spec.unit, path)
      const tensorOrder = getQuantityKindTensorOrder(spec.quantityKind!)
      if (tensorOrder === 0) {
        if (descriptor.basis !== undefined) throw new CadModelError(`${path}.basis is forbidden.`)
      } else {
        normalizeCartesianBasis(descriptor.basis, `${path}.basis`)
        convertUcumValue(0, descriptor.unit, spec.unit, path)
      }
    } catch (error) {
      addIssue(issues, path, error instanceof Error ? error.message : 'has incompatible quantity metadata.')
      return
    }
  } else if (descriptor && descriptor.dtype !== spec.dtype) {
    addIssue(issues, `${path}.dtype`, `must be ${spec.dtype}.`)
  }

  const descriptorAxes = descriptor?.axes
  if (spec.axes === undefined) {
    if (descriptor?.axes !== undefined) addIssue(issues, `${path}.axes`, 'must be omitted.')
  } else if (!Array.isArray(descriptorAxes) || descriptorAxes.length !== spec.axes.length) {
    addIssue(issues, `${path}.axes`, `must contain ${spec.axes.length} axes.`)
  } else {
    spec.axes.forEach((axis, index) => {
      const actual = descriptorAxes[index]
      if (!isRecord(actual) || actual.length !== axis.length) {
        addIssue(issues, `${path}.axes[${index}].length`, `must be ${axis.length}.`)
        return
      }
      if (axis.quantityKind === undefined) {
        if (actual.quantityKind !== undefined || actual.unit !== undefined) {
          addIssue(issues, `${path}.axes[${index}]`, 'must be unitless.')
        }
      } else if (actual.quantityKind !== axis.quantityKind || typeof actual.unit !== 'string') {
        addIssue(issues, `${path}.axes[${index}]`, `must use ${axis.quantityKind} and a compatible unit.`)
      } else {
        try {
          convertUcumValue(1, actual.unit, axis.unit, `${path}.axes[${index}]`)
        } catch (error) {
          addIssue(issues, `${path}.axes[${index}].unit`, error instanceof Error ? error.message : 'is not compatible.')
        }
      }
      if (actual.ticks !== undefined) {
        if (!Array.isArray(actual.ticks) || actual.ticks.length !== axis.length) {
          addIssue(issues, `${path}.axes[${index}].ticks`, `must contain ${axis.length} entries.`)
        }
      }
    })
  }

  const raw = descriptor ? descriptor.value : value
  const expectedOuter = spec.axes?.map((axis) => axis.length!) ?? []
  const expectedComponents = spec.quantityKind ? getQuantityKindComponentShape(spec.quantityKind) : []
  const expectedShape = [...expectedOuter, ...expectedComponents]
  const leaves: unknown[] = []
  const visit = (item: unknown, depth: number) => {
    if (depth === expectedShape.length) {
      if (Array.isArray(item)) {
        addIssue(issues, path, `has an extra array dimension at depth ${depth}.`)
      } else {
        leaves.push(item)
      }
      return
    }
    if (!Array.isArray(item) || item.length !== expectedShape[depth]) {
      addIssue(issues, path, `must have shape ${JSON.stringify(expectedShape)}.`)
      return
    }
    item.forEach((child) => visit(child, depth + 1))
  }
  visit(raw, 0)
  leaves.forEach((leaf, index) => {
    try {
      normalizeDataElement(leaf, spec.dtype, `${path} value ${index}`)
    } catch (error) {
      addIssue(issues, path, error instanceof Error ? error.message : `contains invalid ${spec.dtype} data.`)
      return
    }
    if (spec.dtype === 'string') {
      if (spec.minimumLength !== undefined && (leaf as string).length < spec.minimumLength) {
        addIssue(issues, path, `must contain strings of at least ${spec.minimumLength} characters.`)
      }
      if (spec.values && !spec.values.includes(leaf as string)) {
        addIssue(issues, path, `must contain only ${spec.values.join(', ')}.`)
      }
    }
  })
  if (leaves.length > 0 && spec.dtype !== 'bool' && spec.dtype !== 'string') {
    const numeric = leaves as number[]
    numeric.forEach((item) => {
      let comparable = item
      if (isFloatDType(spec.dtype)) {
        comparable = convertUcumValue(item, descriptor!.unit as string, spec.unit, path)
      }
      if (
        spec.minimum !== undefined &&
        (spec.exclusiveMinimum ? comparable <= spec.minimum : comparable < spec.minimum)
      ) {
        addIssue(issues, path, `must be ${spec.exclusiveMinimum ? 'greater than' : 'at least'} ${spec.minimum}.`)
      }
      if (
        spec.maximum !== undefined &&
        (spec.exclusiveMaximum ? comparable >= spec.maximum : comparable > spec.maximum)
      ) {
        addIssue(issues, path, `must be ${spec.exclusiveMaximum ? 'less than' : 'at most'} ${spec.maximum}.`)
      }
    })
  }
}

function validateParameterValues(
  values: unknown,
  specs: Readonly<Record<string, { required?: boolean; data: KernelValueSpec }>>,
  path: string,
  issues: KernelContractIssue[],
  allowUnknown = false,
) {
  if (!isRecord(values)) {
    addIssue(issues, path, 'must be an object.')
    return
  }
  if (!allowUnknown) {
    Object.keys(values).forEach((name) => {
      if (!Object.prototype.hasOwnProperty.call(specs, name)) {
        addIssue(issues, `${path}.${name}`, 'is not declared.')
      }
    })
  }
  Object.entries(specs).forEach(([name, spec]) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      if (spec.required !== false) addIssue(issues, `${path}.${name}`, 'is required.')
      return
    }
    validateValueShape(values[name], spec.data, `${path}.${name}`, issues)
  })
}

function validateMethodCalls(
  descriptor: KernelDescriptor,
  category: 'initializations' | 'boundaryConditions' | 'outputs',
  calls: unknown,
  world: KernelWorld | undefined,
  issues: KernelContractIssue[],
) {
  const path = `task.${category}`
  if (!Array.isArray(calls)) {
    addIssue(issues, path, 'must be an array.')
    return
  }
  const methods = methodsFor(descriptor, category)
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
  calls.forEach((call, index) => {
    const callPath = `${path}[${index}]`
    if (!isRecord(call)) {
      addIssue(issues, callPath, 'must be a method call.')
      return
    }
    const allowedKeys = new Set(
      category === 'outputs' ? ['key', 'methodId', 'target', 'parameters'] : ['methodId', 'target', 'parameters'],
    )
    Reflect.ownKeys(call).forEach((key) => {
      if (typeof key !== 'string' || !allowedKeys.has(key))
        addIssue(issues, `${callPath}.${String(key)}`, 'is not allowed.')
    })
    const method = typeof call.methodId === 'string' ? methodById.get(call.methodId) : undefined
    if (!method) {
      addIssue(issues, `${callPath}.methodId`, 'is not declared for this category.')
      return
    }
    validateParameterValues(call.parameters, method.parameters, `${callPath}.parameters`, issues)
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
    if (new Set(call.target).size !== call.target.length) {
      addIssue(issues, `${callPath}.target`, 'must not contain duplicates.')
    }
    let resolvedCount = 0
    call.target.forEach((target, targetIndex) => {
      const expectedPrefix = `${method.target.source}.${method.target.kind}.`
      if (typeof target !== 'string' || !target.startsWith(expectedPrefix) || !target.slice(expectedPrefix.length)) {
        addIssue(issues, `${callPath}.target[${targetIndex}]`, `must match ${expectedPrefix}<group>.`)
        return
      }
      if (world) {
        resolvedCount += resolvedTargetCount(
          sceneForTarget(world, method.target.source),
          method.target.kind,
          target.slice(expectedPrefix.length),
        )
      }
    })
    if (world && (resolvedCount < method.target.minimumResolved || resolvedCount > method.target.maximumResolved)) {
      addIssue(
        issues,
        `${callPath}.target`,
        `must resolve to ${method.target.minimumResolved}..${method.target.maximumResolved} parts; resolved ${resolvedCount}.`,
      )
    }
  })
}

function callsForMaterial(config: KernelTaskConfig, material: KernelDescriptor['materials'][number]) {
  return config[material.target.category].filter((call) => call.methodId === material.target.methodId)
}

function validateMaterials(
  descriptor: KernelDescriptor,
  config: KernelTaskConfig,
  world: KernelWorld,
  issues: KernelContractIssue[],
) {
  descriptor.materials.forEach((material) => {
    callsForMaterial(config, material).forEach((call) => {
      call.target.forEach((target) => {
        const [, source, kind, groupName] = /^([^.]+)\.([^.]+)\.(.+)$/.exec(target) ?? []
        if (
          (source !== 'structure' && source !== 'experiment') ||
          (kind !== 'geometry' && kind !== 'surface') ||
          !groupName
        )
          return
        resolvedTargetParts(world.scenes[source], kind, groupName).forEach((part) => {
          const path = `material role ${material.role} on ${target}`
          if (!part.material) {
            addIssue(issues, path, `requires Material properties ${Object.keys(material.properties).join(', ')}.`)
            return
          }
          validateParameterValues(part.material.variables, material.properties, `${path}.variables`, issues, true)
        })
      })
    })
  })
}

export function validateKernelTaskConfig(
  descriptor: KernelDescriptor,
  config: KernelTaskConfig,
  world?: KernelWorld,
): readonly KernelContractIssue[] {
  const issues = [...validateKernelDescriptor(descriptor)]
  if (!isRecord(config)) {
    addIssue(issues, 'task', 'must be an object.')
    return Object.freeze(issues)
  }
  const allowedKeys = new Set(['parameters', 'initializations', 'boundaryConditions', 'outputs'])
  Reflect.ownKeys(config).forEach((key) => {
    if (typeof key !== 'string' || !allowedKeys.has(key)) addIssue(issues, `task.${String(key)}`, 'is not allowed.')
  })
  validateParameterValues(config.parameters, descriptor.parameters, 'task.parameters', issues)
  validateMethodCalls(descriptor, 'initializations', config.initializations, world, issues)
  validateMethodCalls(descriptor, 'boundaryConditions', config.boundaryConditions, world, issues)
  validateMethodCalls(descriptor, 'outputs', config.outputs, world, issues)

  if (Array.isArray(config.outputs)) {
    if (config.outputs.length < (descriptor.minimumOutputs ?? 0)) {
      addIssue(issues, 'task.outputs', `must contain at least ${descriptor.minimumOutputs} requests.`)
    }
    const keys = new Set<string>()
    config.outputs.forEach((output, index) => {
      if (!isRecord(output) || typeof output.key !== 'string' || !output.key.trim()) {
        addIssue(issues, `task.outputs[${index}].key`, 'must be a non-empty string.')
      } else if (keys.has(output.key)) {
        addIssue(issues, `task.outputs[${index}].key`, `${output.key} is duplicated within this task.`)
      } else {
        keys.add(output.key)
      }
    })
  }
  if (world) validateMaterials(descriptor, config, world, issues)
  return Object.freeze(issues)
}

export function assertValidKernelTaskConfig(
  descriptor: KernelDescriptor,
  config: KernelTaskConfig,
  world?: KernelWorld,
) {
  throwIssues(`Task for ${descriptor.name}@${descriptor.version}`, validateKernelTaskConfig(descriptor, config, world))
}

function normalizeValue(value: ExperimentParameter, spec: KernelValueSpec, path: string): ExperimentParameter {
  if (!isRecord(value)) return value
  const descriptor = value as DataValueDescriptor
  if (!isFloatDType(spec.dtype)) {
    return Object.freeze(structuredClone(value)) as ExperimentParameter
  }
  const quantityKind = spec.quantityKind!
  const componentShape = getQuantityKindComponentShape(quantityKind)
  const source = {
    unit: descriptor.unit!,
    ...(descriptor.basis === undefined ? {} : { basis: descriptor.basis }),
  }
  const target = {
    unit: spec.unit!,
    ...(spec.basis === undefined ? {} : { basis: spec.basis }),
  }
  const outerRank = spec.axes?.length ?? 0
  const transform = (item: unknown, depth: number, itemPath: string): unknown => {
    if (depth === outerRank) {
      return transformQuantityValue(item, componentShape, source, target, itemPath)
    }
    return Object.freeze(
      (item as readonly unknown[]).map((child, index) => transform(child, depth + 1, `${itemPath}[${index}]`)),
    )
  }
  const axes = spec.axes?.map((axis, index) => {
    const inputAxis = descriptor.axes![index]
    const ticks = inputAxis.ticks?.map((tick, tickIndex) =>
      typeof tick === 'number' && axis.unit
        ? convertUcumValue(tick, inputAxis.unit, axis.unit, `${path}.axes[${index}].ticks[${tickIndex}]`)
        : tick,
    )
    return Object.freeze({
      length: inputAxis.length,
      ...(axis.name === undefined ? {} : { name: axis.name }),
      ...(ticks === undefined ? {} : { ticks: Object.freeze(ticks) }),
      ...(axis.unit === undefined ? {} : { unit: axis.unit, quantityKind: axis.quantityKind! }),
    })
  })
  return Object.freeze({
    dtype: spec.dtype,
    value: transform(descriptor.value, 0, `${path}.value`),
    unit: spec.unit!,
    quantityKind,
    ...(spec.basis === undefined ? {} : { basis: spec.basis }),
    ...(axes === undefined ? {} : { axes: Object.freeze(axes) }),
  }) as ExperimentParameter
}

function normalizeParameters(
  values: Readonly<Record<string, ExperimentParameter>>,
  specs: Readonly<Record<string, { data: KernelValueSpec }>>,
  path: string,
) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, normalizeValue(value, specs[name].data, `${path}.${name}`)]),
    ),
  )
}

function normalizeCalls(
  calls: readonly KernelMethodCall[],
  methods: readonly (KernelMethodDescriptor | KernelOutputMethodDescriptor)[],
  path: string,
) {
  return Object.freeze(
    calls.map((call, index) => {
      const method = methods.find((candidate) => candidate.methodId === call.methodId)!
      return Object.freeze({
        ...call,
        target: Object.freeze([...call.target]),
        parameters: normalizeParameters(call.parameters, method.parameters, `${path}[${index}].parameters`),
      })
    }),
  )
}

export function normalizeKernelTaskConfig(
  descriptor: KernelDescriptor,
  config: KernelTaskConfig,
  world?: KernelWorld,
): KernelTaskConfig {
  assertValidKernelTaskConfig(descriptor, config, world)
  return Object.freeze({
    parameters: normalizeParameters(config.parameters, descriptor.parameters, 'task.parameters'),
    initializations: normalizeCalls(config.initializations, descriptor.methods.initializations, 'task.initializations'),
    boundaryConditions: normalizeCalls(
      config.boundaryConditions,
      descriptor.methods.boundaryConditions,
      'task.boundaryConditions',
    ),
    outputs: Object.freeze(
      normalizeCalls(config.outputs, descriptor.methods.outputs, 'task.outputs').map((output, index) =>
        Object.freeze({
          ...output,
          key: config.outputs[index].key,
        }),
      ),
    ),
  })
}

export function resolveKernelOutputSpecs(
  descriptor: KernelDescriptor,
  config: KernelTaskConfig,
): Readonly<Record<string, ResolvedKernelOutputSpec>> {
  const methodById = new Map(descriptor.methods.outputs.map((method) => [method.methodId, method]))
  const resolved = Object.fromEntries(
    config.outputs.map((output) => {
      const method = methodById.get(output.methodId)
      if (!method) {
        throw new CadModelError(
          `Task output ${output.key} uses unknown method ${output.methodId} for ${descriptor.name}@${descriptor.version}.`,
        )
      }
      return [output.key, Object.freeze({ artifactType: method.artifactType, data: method.data })]
    }),
  )
  if (Object.keys(resolved).length !== config.outputs.length) {
    throw new CadModelError(`Task for ${descriptor.name}@${descriptor.version} contains duplicate output keys.`)
  }
  return Object.freeze(resolved)
}

export function resolveKernelInputPort(
  descriptor: KernelDescriptor,
  name: string,
): KernelInputPortDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(descriptor.inputPorts, name) ? descriptor.inputPorts[name] : undefined
}
