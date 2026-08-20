import { describe, expect, it } from 'vitest'
import coreDeclarations from '../api/caemble-core.d.ts?raw'
import jsxDeclarations from '../api/cad-jsx.d.ts?raw'
import { cadAuthoringContract, cadElementCatalog } from '../catalog'
import * as cadFacade from '../index'
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

  it('keeps complete element metadata separate from the shared identity and transform contract', () => {
    expect(cadAuthoringContract).toMatchObject({
      apiVersion: 7,
      identity: { name: 'id', pathExample: 'goal.pole' },
      transforms: { applicationOrder: ['scale', 'rotation', 'position'] },
    })
    const commonProperties = new Set(['id', 'position', 'rotation', 'scale', 'pos', 'rotate'])
    cadElementCatalog.forEach((manifest) => {
      expect(manifest.keywords.length).toBeGreaterThan(0)
      expect(manifest.children.description).not.toBe('')
      expect(manifest.origin).not.toBe('')
      expect(manifest.surfaces.length).toBeGreaterThan(0)
      expect(manifest.example).toContain(`<${manifest.authoringName}`)
      expect(manifest.properties.every((property) => !commonProperties.has(property.name))).toBe(true)
    })

    const defaults = Object.fromEntries(
      cadElementCatalog.flatMap((manifest) =>
        manifest.properties.flatMap((property) =>
          'default' in property && property.default !== undefined
            ? [[`${manifest.tag}.${property.name}`, property.default]]
            : [],
        ),
      ),
    )
    expect(defaults).toMatchObject({
      'curvedEdgeCylinder.azimuthalSegments': '64',
      'curvedEdgeCylinder.verticalSegments': '32',
      'curvedSurfaceSphere.azimuthalSegments': '64',
      'curvedSurfaceSphere.polarSegments': '32',
      'fiber.envelopePower': '2',
      'fiber.pathSegments': '128',
      'fiber.radialSegments': '12',
    })
  })

  it('uses the generated declaration files for public core types', () => {
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
      'TranslateAttributes',
      'RotateAttributes',
      'ScaleAttributes',
    ]) {
      expect(coreDeclarations).toContain(`export type ${typeName}`)
    }
    for (const [name, tag] of [
      ['Box', 'box'],
      ['Cylinder', 'cylinder'],
      ['CurvedEdgeCylinder', 'curvedEdgeCylinder'],
      ['Sphere', 'sphere'],
      ['CurvedSurfaceSphere', 'curvedSurfaceSphere'],
      ['Fiber', 'fiber'],
    ]) {
      expect(coreDeclarations).toContain(`export const ${name}: '${tag}'`)
      expect(jsxDeclarations).toContain(`@deprecated Import { ${name} }`)
    }
    expect(coreDeclarations).toContain('export function radians(degrees: Vec3): Vec3')
    expect(coreDeclarations).not.toContain('IDENTITY_CARTESIAN_BASIS')

    const cylinderDeclaration = coreDeclarations.match(/export type CylinderAttributes = Readonly<\{[\s\S]*?\n\}>/)?.[0]
    expect(cylinderDeclaration).toContain('radius_2?: number')

    const shellDeclaration = coreDeclarations.match(/export type ShellAttributes = Readonly<\{[\s\S]*?\n\}>/)?.[0]
    expect(shellDeclaration).toContain('offsets: Readonly<Record<string, number>>')
    expect(shellDeclaration).not.toContain('depth')
    expect(jsxDeclarations).toContain('shell: ShellAttributes')
    expect(coreDeclarations).toMatch(/GeometryAttributes[\s\S]*?id: string/)
    expect(coreDeclarations).toMatch(
      /GeometryAttributes[\s\S]*?materials\?: Readonly<Record<string, Material \| undefined>>/,
    )
    expect(coreDeclarations).not.toContain('tasks: (context: ModelContext<Schema>) => Tasks')
    expect(coreDeclarations).toContain('config: (context: TaskModelContext) => Config')
    expect(coreDeclarations).toContain("readonly documentType: 'task'")
    expect(coreDeclarations).toContain('formatVersion: 5')
    expect(coreDeclarations).toContain('simulationApiVersion: 3')
    expect(coreDeclarations).toContain('recordedData: Recorded')
    expect(coreDeclarations).not.toContain('simulate?: (')
    expect(coreDeclarations).not.toContain('ExperimentRule')
    expect(cadElementCatalog.find((element) => element.tag === 'shell')).toMatchObject({
      category: 'operation',
      syntax: '<shell offsets={{ inner: -1, outer: 1 }}>Geometry</shell>',
    })
  })

  it('derives QuantityKind authoring types from the selected runtime catalog map', () => {
    expect(coreDeclarations).toContain('export interface CatalogQuantityKindMap {}')
    expect(coreDeclarations).toContain("CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? never : Name")
    expect(coreDeclarations).toContain("CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? Name : never")
    expect(coreDeclarations).toContain("CatalogQuantityKindMap[Name]['applicableUnits'][number]")
    expect(coreDeclarations).not.toMatch(/\| 'Length'/)
  })

  it('exposes model and evaluation APIs through the CAD facade', () => {
    expect(cadFacade).not.toHaveProperty('IDENTITY_CARTESIAN_BASIS')
    expect(quantityKindFacade).not.toHaveProperty('IDENTITY_CARTESIAN_BASIS')
    expect(cadFacade).toMatchObject({
      CadModelError: expect.any(Function),
      experiment: expect.any(Function),
      Mat: expect.any(Function),
      Material: expect.any(Function),
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
