import type { Vec3 } from '../cad/model/types'
import { convertUcumValue, normalizeUcumUnit, type UcumUnit } from '../cad/model/units'
import { identityCartesianBasis } from './identityBasis'
import { getRuntimeQuantityKind } from '../catalog/runtime'

export type QuantityKindName = string
export type QuantityKindDomain = string
export type QuantityKindNameForDomain<Domain extends QuantityKindDomain> = string & { readonly __domain?: Domain }
export type QuantityKindTensorOrder<Name extends QuantityKindName> = number & { readonly __quantityKind?: Name }
export type QuantityKindComponentShape<Name extends QuantityKindName> = readonly 3[] & { readonly __quantityKind?: Name }
export type QuantityKindComponentValue<Name extends QuantityKindName> = any & { readonly __quantityKind?: Name }
export type ScalarQuantityKindName = string
export type TensorQuantityKindName = string
export type CartesianBasis = readonly [Vec3, Vec3, Vec3]

export type QuantityValueReference = Readonly<{ unit: UcumUnit; basis?: CartesianBasis }>

export function componentShapeForTensorOrder(order: number, _path = 'Tensor order'): readonly 3[] {
  return Object.freeze(Array.from({ length: order }, () => 3 as const))
}

export function getQuantityKindTensorOrder<Name extends QuantityKindName>(name: Name): QuantityKindTensorOrder<Name> {
  return getRuntimeQuantityKind(name).tensorOrder as QuantityKindTensorOrder<Name>
}

export function getQuantityKindComponentShape<Name extends QuantityKindName>(name: Name): QuantityKindComponentShape<Name> {
  return componentShapeForTensorOrder(getQuantityKindTensorOrder(name)) as QuantityKindComponentShape<Name>
}

export function normalizeCartesianBasis(value: unknown, _path: string): CartesianBasis {
  return Object.freeze((value as CartesianBasis).map((axis) => Object.freeze([...axis]) as Vec3)) as CartesianBasis
}

export function transformQuantityComponents(
  value: unknown,
  componentShape: readonly 3[],
  fromUnit: UcumUnit,
  toUnit: UcumUnit,
  path = 'Quantity component transform',
): unknown {
  const transformComponent = (input: unknown, depth: number): unknown => {
    if (depth === componentShape.length) return convertUcumValue(input as number, fromUnit, toUnit, path)
    return Object.freeze((input as readonly unknown[]).map((component) => transformComponent(component, depth + 1)))
  }
  return transformComponent(value, 0)
}

export function transformQuantityValue(
  value: unknown,
  componentShape: readonly 3[],
  source: QuantityValueReference,
  target: QuantityValueReference,
  path = 'Quantity value transform',
): unknown {
  if (componentShape.length === 0) return transformQuantityComponents(value, componentShape, source.unit, target.unit, path)
  const sourceBasis = source.basis ?? identityCartesianBasis
  const targetBasis = target.basis ?? identityCartesianBasis
  const converted = transformQuantityComponents(value, componentShape, source.unit, target.unit, path)
  const rotation = targetBasis.map((targetAxis) =>
    Object.freeze(sourceBasis.map((sourceAxis) => targetAxis[0] * sourceAxis[0] + targetAxis[1] * sourceAxis[1] + targetAxis[2] * sourceAxis[2])),
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
        sumSourceComponents([...sourceIndices, index], sourceDepth + 1, weight * rotation[targetIndices[sourceDepth]][index])
      }
    }
    sumSourceComponents([], 0, 1)
    return total
  }
  return buildTargetComponents([], 0)
}

type QuantityBasisMetadata<Name extends QuantityKindName> = Readonly<{ basis?: CartesianBasis }> & { readonly __quantityKind?: Name }
export type QuantityMetadata<Name extends QuantityKindName = QuantityKindName> = Readonly<{ unit: UcumUnit; quantityKind: Name }> & QuantityBasisMetadata<Name>
export type ApplicableUnit<Name extends QuantityKindName> = UcumUnit & { readonly __quantityKind?: Name }

export interface QuantityKindDefinition<Name extends QuantityKindName> {
  readonly name: Name
  domain(): QuantityKindDomain
  description(): string | undefined
  applicableUnits(): readonly UcumUnit[]
  tensorOrder(): QuantityKindTensorOrder<Name>
  componentShape(): QuantityKindComponentShape<Name>
  transform(value: QuantityKindComponentValue<Name>, fromUnit: ApplicableUnit<Name>, toUnit: ApplicableUnit<Name>): QuantityKindComponentValue<Name>
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
  _scalarOnly = false,
): QuantityMetadata {
  const quantityKind = value.quantityKind as QuantityKindName
  const unit = normalizeUcumUnit(value.unit, `${path}.unit`)
  const tensorOrder = getRuntimeQuantityKind(quantityKind).tensorOrder
  const basis = tensorOrder > 0 ? (value.basis as CartesianBasis | undefined) ?? identityCartesianBasis : undefined
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
  description(): string | undefined { return getRuntimeQuantityKind(this.name).description ?? undefined }
  domain(): QuantityKindDomain { return getRuntimeQuantityKind(this.name).domain }
  applicableUnits(): readonly UcumUnit[] { return Object.freeze([...getRuntimeQuantityKind(this.name).applicableUnits]) }
  tensorOrder(): QuantityKindTensorOrder<Name> { return getQuantityKindTensorOrder(this.name) }
  componentShape(): QuantityKindComponentShape<Name> { return this.componentShapeValue }
  transform(value: QuantityKindComponentValue<Name>, fromUnit: ApplicableUnit<Name>, toUnit: ApplicableUnit<Name>): QuantityKindComponentValue<Name> {
    return transformQuantityValue(value, this.componentShape(), { unit: fromUnit }, { unit: toUnit }) as QuantityKindComponentValue<Name>
  }
}
