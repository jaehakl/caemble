import { describe, expect, it } from 'vitest'
import coreDeclarations from '../api/caemble-core.d.ts?raw'
import jsxDeclarations from '../api/cad-jsx.d.ts?raw'
import monacoSetupSource from '../compiler/monacoSetup.ts?raw'
import { cadElementCatalog } from '../catalog'
import * as cadFacade from '../index'
import { QuantityKind } from '../../quantitykind'
import { quantityKindDomains } from '../../quantitykind/data'
import * as quantityKindFacade from '../../quantitykind'
import { cadElementDefinitions, createCadElementRegistry } from './registry'
import type { CadElementDefinition } from './types'

describe('CAD registry contracts', () => {
  it('rejects duplicate tags at registry creation', () => {
    const duplicate = cadElementDefinitions[0] as CadElementDefinition
    expect(() => createCadElementRegistry([duplicate, duplicate])).toThrow('Duplicate CAD element tag: box')
  })

  it('requires primitive surface definitions and operation surface policies', () => {
    cadElementDefinitions.forEach((definition) => {
      if (definition.kind === 'primitive') {
        expect(definition.createSurfaces).toEqual(expect.any(Function))
      } else {
        expect(['preserve', 'derive']).toContain(definition.surfacePolicy)
      }
    })
  })

  it('keeps evaluation registry, catalog, and ambient JSX tags in sync', () => {
    const registryTags = cadElementDefinitions.map((definition) => definition.tag).sort()
    const catalogTags = cadElementCatalog.map((manifest) => manifest.tag).sort()
    const jsxTags = [...jsxDeclarations.matchAll(/^\s{6}(\w+):/gm)].map((match) => match[1]).sort()

    expect(catalogTags).toEqual(registryTags)
    expect(jsxTags).toEqual(registryTags)
    expect(new Set(cadElementCatalog.map((manifest) => manifest.category))).toEqual(new Set(['primitive', 'operation']))
  })

  it('uses shared declaration files for public core types and Monaco', () => {
    for (const typeName of [
      'BoxAttributes',
      'ShellAttributes',
      'CylinderAttributes',
      'CurvedEdgeCylinderAttributes',
      'CurvedEdgeCylinderFourierMode',
      'CurvedEdgeCylinderTaylorCurve',
      'CurvedSurfaceSphereAttributes',
      'CurvedSurfaceSphereFourierMode',
      'SphereAttributes',
      'ArrayAttributes',
      'FiberAttributes',
    ]) {
      expect(coreDeclarations).toContain(`export type ${typeName}`)
    }
    expect(monacoSetupSource).toContain("import coreTypes from '../api/caemble-core.d.ts?raw'")
    expect(monacoSetupSource).toContain("import jsxTypes from '../api/cad-jsx.d.ts?raw'")
    expect(monacoSetupSource).toContain("'file:///node_modules/@caemble/core/index.d.ts'")
    expect(monacoSetupSource).not.toContain('const cadTypes')
    expect(coreDeclarations).not.toContain('IDENTITY_CARTESIAN_BASIS')

    const cylinderDeclaration = coreDeclarations.match(/export type CylinderAttributes = Readonly<\{[\s\S]*?\n\}>/)?.[0]
    expect(cylinderDeclaration).toContain('radius_2?: number')

    const shellDeclaration = coreDeclarations.match(/export type ShellAttributes = Readonly<\{[\s\S]*?\n\}>/)?.[0]
    expect(shellDeclaration).toContain('offsets: readonly number[]')
    expect(shellDeclaration).not.toContain('depth')
    expect(jsxDeclarations).toContain('shell: ShellAttributes')
    expect(coreDeclarations).toMatch(/GeometryAttributes[\s\S]*?id: string/)
    expect(coreDeclarations).toContain('tasks: (context: ModelContext<Schema>) => Tasks')
    expect(coreDeclarations).toContain('recordedData: Recorded')
    expect(coreDeclarations).toContain('simulate: (')
    expect(coreDeclarations).not.toContain('ExperimentRule')
    expect(cadElementCatalog.find((element) => element.tag === 'shell')).toMatchObject({
      category: 'operation',
      syntax: '<shell offsets={[-inner, outer]}>Geometry</shell>',
    })
  })

  it('keeps the Monaco QuantityKindName union synchronized with the generated facade', () => {
    const declaration = coreDeclarations.match(
      /export type QuantityKindName =([\s\S]*?)export type QuantityKindDomain/,
    )?.[1]
    const declarationNames = [...(declaration?.matchAll(/\| '([^']+)'/g) ?? [])].map((match) => match[1])

    expect(declarationNames).toHaveLength(1_216)
    expect(declarationNames.sort()).toEqual(Object.keys(QuantityKind).sort())

    const domainDeclaration = coreDeclarations.match(
      /export type QuantityKindDomain =([\s\S]*?)export type QuantityKindNameForDomain/,
    )?.[1]
    const declarationDomains = [...(domainDeclaration?.matchAll(/\| '([^']+)'/g) ?? [])].map((match) => match[1])
    expect(declarationDomains).toEqual(quantityKindDomains)

    const tensorDeclaration = coreDeclarations.match(
      /export type TensorQuantityKindName =([\s\S]*?)export type ScalarQuantityKindName/,
    )?.[1]
    const tensorDeclarationNames = [...(tensorDeclaration?.matchAll(/\| '([^']+)'/g) ?? [])].map((match) => match[1])
    const tensorQuantityKindNames = Object.values(QuantityKind)
      .filter((entry) => entry.tensorOrder() > 0)
      .map((entry) => entry.name)

    expect(tensorDeclarationNames.sort()).toEqual(tensorQuantityKindNames.sort())
  })

  it('exposes model and evaluation APIs through the CAD facade', () => {
    expect(cadFacade).not.toHaveProperty('IDENTITY_CARTESIAN_BASIS')
    expect(quantityKindFacade).not.toHaveProperty('IDENTITY_CARTESIAN_BASIS')
    expect(cadFacade).toMatchObject({
      CadModelError: expect.any(Function),
      experiment: expect.any(Function),
      Mat: expect.any(Function),
      Material: expect.any(Function),
      structure: expect.any(Function),
      evaluateCad: expect.any(Function),
      evaluateCadScene: expect.any(Function),
      applyCadSceneGroups: expect.any(Function),
      h: expect.any(Function),
    })
    expect(cadFacade).not.toHaveProperty('Sample')
    expect(cadFacade).not.toHaveProperty('Setup')
    expect(cadFacade).not.toHaveProperty('vars')
  })
})
