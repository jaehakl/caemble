import { CadModelError } from '../cad/model/errors'
import type { Vec3 } from '../cad/model/types'
import { convertUcumValue, normalizeUcumUnit, type UcumUnit } from '../cad/model/units'
import { identityCartesianBasis } from './identityBasis'
import { getRuntimeQuantityKind } from '../catalog/runtime'

export type QuantityKindName = string
export type QuantityKindDomain = string
export type QuantityKindNameForDomain<Domain extends QuantityKindDomain> = string & { readonly __domain?: Domain }
export type QuantityKindTensorOrder<Name extends QuantityKindName> = number & { readonly __quantityKind?: Name }

export type QuantityKindComponentShape<Name extends QuantityKindName> = readonly 3[] & {
  readonly __quantityKind?: Name
}

// Runtime catalog slices determine the exact component rank, so it cannot be encoded in the base declaration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuantityKindComponentValue<Name extends QuantityKindName> = any & { readonly __quantityKind?: Name }

export type ScalarQuantityKindName = string
export type TensorQuantityKindName = string

export type CartesianBasis = readonly [Vec3, Vec3, Vec3]

export type QuantityValueReference = Readonly<{
  unit: UcumUnit
  basis?: CartesianBasis
}>

export function componentShapeForTensorOrder(order: number, path = 'Tensor order'): readonly 3[] {
  if (!Number.isSafeInteger(order) || order < 0) {
    throw new CadModelError(`${path} must be a non-negative safe integer.`)
  }
  return Object.freeze(Array.from({ length: order }, () => 3 as const))
}

export function getQuantityKindTensorOrder<Name extends QuantityKindName>(name: Name): QuantityKindTensorOrder<Name> {
  return getRuntimeQuantityKind(name).tensorOrder as QuantityKindTensorOrder<Name>
}

export function getQuantityKindComponentShape<Name extends QuantityKindName>(
  name: Name,
): QuantityKindComponentShape<Name> {
  return componentShapeForTensorOrder(
    getQuantityKindTensorOrder(name),
    `QuantityKind ${name} tensorOrder`,
  ) as QuantityKindComponentShape<Name>
}

export function normalizeCartesianBasis(value: unknown, path: string): CartesianBasis {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new CadModelError(`${path} must contain exactly three Cartesian basis vectors.`)
  }
  const basis = value.map((axis, axisIndex) => {
    if (
      !Array.isArray(axis) ||
      axis.length !== 3 ||
      axis.some((component) => typeof component !== 'number' || !Number.isFinite(component))
    ) {
      throw new CadModelError(`${path}[${axisIndex}] must contain exactly three finite numbers.`)
    }
    return Object.freeze([axis[0], axis[1], axis[2]] as const)
  }) as unknown as CartesianBasis
  const tolerance = 1e-9
  for (let left = 0; left < basis.length; left += 1) {
    for (let right = left; right < basis.length; right += 1) {
      const dot = basis[left][0] * basis[right][0] + basis[left][1] * basis[right][1] + basis[left][2] * basis[right][2]
      const expected = left === right ? 1 : 0
      if (Math.abs(dot - expected) > tolerance) {
        throw new CadModelError(`${path} must be an orthonormal Cartesian basis.`)
      }
    }
  }
  const determinant =
    basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1]) -
    basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0]) +
    basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0])
  if (Math.abs(determinant - 1) > tolerance) {
    throw new CadModelError(`${path} must be a right-handed Cartesian basis.`)
  }
  return Object.freeze(basis)
}

export function transformQuantityComponents(
  value: unknown,
  componentShape: readonly 3[],
  fromUnit: UcumUnit,
  toUnit: UcumUnit,
  path = 'Quantity component transform',
): unknown {
  if (componentShape.length > 0) {
    const transformedZero = convertUcumValue(0, fromUnit, toUnit, path)
    if (transformedZero !== 0) {
      throw new CadModelError(`${path} requires a zero-preserving unit transform for tensor components.`)
    }
  }

  const transformComponent = (input: unknown, depth: number, componentPath: string): unknown => {
    if (depth === componentShape.length) {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        throw new CadModelError(`${componentPath} must be a finite tensor component.`)
      }
      return convertUcumValue(input, fromUnit, toUnit, path)
    }
    if (!Array.isArray(input) || input.length !== 3) {
      throw new CadModelError(`${componentPath} must have component shape ${JSON.stringify(componentShape)}.`)
    }
    return Object.freeze(
      input.map((component, index) => transformComponent(component, depth + 1, `${componentPath}[${index}]`)),
    )
  }

  return transformComponent(value, 0, `${path} value`)
}

export function transformQuantityValue(
  value: unknown,
  componentShape: readonly 3[],
  source: QuantityValueReference,
  target: QuantityValueReference,
  path = 'Quantity value transform',
): unknown {
  if (componentShape.some((length) => length !== 3)) {
    throw new CadModelError(`${path} component shape must contain only Cartesian dimensions of 3.`)
  }
  if (componentShape.length === 0) {
    if (source.basis !== undefined || target.basis !== undefined) {
      throw new CadModelError(`${path} basis is forbidden for a scalar quantity.`)
    }
    return transformQuantityComponents(value, componentShape, source.unit, target.unit, path)
  }

  const sourceBasis =
    source.basis === undefined ? identityCartesianBasis : normalizeCartesianBasis(source.basis, `${path} source basis`)
  const targetBasis =
    target.basis === undefined ? identityCartesianBasis : normalizeCartesianBasis(target.basis, `${path} target basis`)
  const converted = transformQuantityComponents(value, componentShape, source.unit, target.unit, path)
  const rotation = targetBasis.map((targetAxis) =>
    Object.freeze(
      sourceBasis.map(
        (sourceAxis) => targetAxis[0] * sourceAxis[0] + targetAxis[1] * sourceAxis[1] + targetAxis[2] * sourceAxis[2],
      ),
    ),
  )

  const componentAt = (indices: readonly number[]) => {
    let component = converted
    for (const index of indices) component = (component as readonly unknown[])[index]
    return component as number
  }
  const buildTargetComponents = (targetIndices: readonly number[], depth: number): unknown => {
    if (depth < componentShape.length) {
      return Object.freeze([0, 1, 2].map((index) => buildTargetComponents([...targetIndices, index], depth + 1)))
    }

    let total = 0
    const sumSourceComponents = (sourceIndices: readonly number[], sourceDepth: number, weight: number) => {
      if (sourceDepth === componentShape.length) {
        total += weight * componentAt(sourceIndices)
        return
      }
      for (let index = 0; index < 3; index += 1) {
        sumSourceComponents(
          [...sourceIndices, index],
          sourceDepth + 1,
          weight * rotation[targetIndices[sourceDepth]][index],
        )
      }
    }
    sumSourceComponents([], 0, 1)
    return total
  }

  return buildTargetComponents([], 0)
}

type QuantityBasisMetadata<Name extends QuantityKindName> = Readonly<{ basis?: CartesianBasis }> & {
  readonly __quantityKind?: Name
}

export type QuantityMetadata<Name extends QuantityKindName = QuantityKindName> = Readonly<{
  unit: UcumUnit
  quantityKind: Name
}> &
  QuantityBasisMetadata<Name>

export type ApplicableUnit<Name extends QuantityKindName> = UcumUnit & { readonly __quantityKind?: Name }

export interface QuantityKindDefinition<Name extends QuantityKindName> {
  readonly name: Name
  domain(): QuantityKindDomain
  description(): string | undefined
  applicableUnits(): readonly UcumUnit[]
  tensorOrder(): QuantityKindTensorOrder<Name>
  componentShape(): QuantityKindComponentShape<Name>
  transform(
    value: QuantityKindComponentValue<Name>,
    fromUnit: ApplicableUnit<Name>,
    toUnit: ApplicableUnit<Name>,
  ): QuantityKindComponentValue<Name>
}

export function normalizeQuantityMetadata(
  value: Readonly<Record<string, unknown>>,
  path: string,
  scalarOnly: true,
): QuantityMetadata<ScalarQuantityKindName>
export function normalizeQuantityMetadata(
  value: Readonly<Record<string, unknown>>,
  path: string,
  scalarOnly?: false,
): QuantityMetadata
export function normalizeQuantityMetadata(
  value: Readonly<Record<string, unknown>>,
  path: string,
  scalarOnly = false,
): QuantityMetadata {
  if (
    !Object.prototype.hasOwnProperty.call(value, 'unit') ||
    !Object.prototype.hasOwnProperty.call(value, 'quantityKind')
  ) {
    throw new CadModelError(`${path} must specify both unit and quantityKind.`)
  }

  if (
    typeof value.quantityKind !== 'string' ||
    !value.quantityKind
  ) {
    throw new CadModelError(`${path}.quantityKind must be a known Quantity Kind name.`)
  }

  const quantityKind = value.quantityKind as QuantityKindName
  const unit = normalizeUcumUnit(value.unit, `${path}.unit`)
  const definition = getRuntimeQuantityKind(quantityKind)
  if (!definition.applicableUnits.includes(unit)) {
    throw new CadModelError(`${path}.unit ${unit} is not applicable to Quantity Kind ${quantityKind}.`)
  }

  const tensorOrder = definition.tensorOrder
  if (scalarOnly && tensorOrder > 0) {
    throw new CadModelError(
      `${path}.quantityKind ${quantityKind} has tensor order ${tensorOrder} and component shape ${JSON.stringify(getQuantityKindComponentShape(quantityKind))}; use a float dtype descriptor without axes, the complete component value, and basis.`,
    )
  }
  const hasBasis = Object.prototype.hasOwnProperty.call(value, 'basis')
  if (tensorOrder === 0 && hasBasis) {
    throw new CadModelError(`${path}.basis is not allowed for scalar Quantity Kind ${quantityKind}.`)
  }
  const basis =
    tensorOrder > 0
      ? hasBasis
        ? normalizeCartesianBasis(value.basis, `${path}.basis`)
        : identityCartesianBasis
      : undefined

  return Object.freeze({ unit, quantityKind, ...(basis === undefined ? {} : { basis }) }) as QuantityMetadata
}

export class QuantityKindEntry<Name extends QuantityKindName> implements QuantityKindDefinition<Name> {
  readonly name: Name
  private readonly componentShapeValue: QuantityKindComponentShape<Name>

  constructor(name: Name) {
    this.name = name
    this.componentShapeValue = getQuantityKindComponentShape(name)
    Object.freeze(this)
  }

  description(): string | undefined {
    return getRuntimeQuantityKind(this.name).description ?? undefined
  }

  domain(): QuantityKindDomain {
    return getRuntimeQuantityKind(this.name).domain
  }

  applicableUnits(): readonly UcumUnit[] {
    return Object.freeze([...getRuntimeQuantityKind(this.name).applicableUnits])
  }

  tensorOrder(): QuantityKindTensorOrder<Name> {
    return getQuantityKindTensorOrder(this.name)
  }

  componentShape(): QuantityKindComponentShape<Name> {
    return this.componentShapeValue
  }

  transform(
    value: QuantityKindComponentValue<Name>,
    fromUnit: ApplicableUnit<Name>,
    toUnit: ApplicableUnit<Name>,
  ): QuantityKindComponentValue<Name> {
    const applicableUnits = this.applicableUnits() as readonly string[]
    if (!applicableUnits.includes(fromUnit)) {
      throw new CadModelError(`QuantityKind ${this.name} does not include source UCUM unit ${fromUnit}.`)
    }
    if (!applicableUnits.includes(toUnit)) {
      throw new CadModelError(`QuantityKind ${this.name} does not include target UCUM unit ${toUnit}.`)
    }
    if (getRuntimeQuantityKind(this.name).opaque && fromUnit !== toUnit) {
      throw new CadModelError(`QuantityKind ${this.name} does not support unit conversion.`)
    }

    return transformQuantityValue(
      value,
      this.componentShape(),
      { unit: fromUnit },
      { unit: toUnit },
      `QuantityKind ${this.name} transform`,
    ) as QuantityKindComponentValue<Name>
  }
}
