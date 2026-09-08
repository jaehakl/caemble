import type { MaterialSnapshot, MaterialDefinition } from '@/contracts/material'
import type { CadSceneMaterial } from '../cad/evaluation/types'
import { CadModelError } from '../cad/model/errors'

export type { MaterialSnapshot } from '@/contracts/material'
export type MaterialResolution = Readonly<{ materialSnapshot: MaterialSnapshot; warnings: readonly string[] }>

export function materialVarsHash(vars: Readonly<Record<string, unknown>>): string {
  const bytes = new DataView(new ArrayBuffer(8))
  const encode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(encode)
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CadModelError('Vars fingerprint requires finite numeric tensors.')
    bytes.setFloat64(0, value === 0 ? 0 : value, false)
    return Array.from(new Uint8Array(bytes.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const canonical = JSON.stringify(Object.keys(vars).sort().map((key) => [key, encode(vars[key])]))
  let hash = 14695981039346656037n
  for (const byte of new TextEncoder().encode(canonical)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n)
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

export function canonicalMaterialJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMaterialJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalMaterialJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function resolveMaterialSnapshot(materials: readonly CadSceneMaterial[], locations: readonly string[] = []): MaterialResolution {
  const definitions: Record<string, MaterialDefinition> = Object.create(null)
  const origins = new Map<string, string>()
  for (const [index, material] of materials.entries()) {
    const definition = Object.freeze({ ...(material.color === undefined ? {} : { color: material.color }), models: material.models })
    const previous = definitions[material.name]
    if (previous && canonicalMaterialJson(previous) !== canonicalMaterialJson(definition)) throw new CadModelError(`Material ${material.name} has conflicting definitions at ${origins.get(material.name)} and ${locations[index] ?? `materials[${index}]`}.`)
    definitions[material.name] = definition
    origins.set(material.name, locations[index] ?? `materials[${index}]`)
  }
  return Object.freeze({ materialSnapshot: Object.freeze({ materials: Object.freeze(definitions) }), warnings: Object.freeze([]) })
}

export function projectMaterialResolution(resolution: MaterialResolution, materials: readonly CadSceneMaterial[]): MaterialResolution {
  const names = new Set(materials.map((material) => material.name))
  return Object.freeze({ materialSnapshot: Object.freeze({ materials: Object.freeze(Object.fromEntries(Object.entries(resolution.materialSnapshot.materials).filter(([name]) => names.has(name)))) }), warnings: resolution.warnings })
}
