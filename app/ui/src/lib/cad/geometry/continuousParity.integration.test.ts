// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  evaluateContinuousSurface,
  tessellateContinuousPrimitive,
  type ContinuousPrimitive,
  type IndexedSurface,
} from './continuous'
import { evaluateFiber, normalizeFiber, tessellateFiber } from './fiber'
import { cadElementCatalog } from '../elements/generated'
import { readCatalogExamples } from '../../../../scripts/catalog-example-support'
import { compileNodeCadDocument } from '../../../platform/node/cadCompiler'
import { executeCompiledDocument } from '../execution/userModule'
import { canonicalGeometryScene } from '../evaluation/canonical'
import { installCatalogRuntimeSlice } from '../../catalog/runtime'

it('UI and worker evaluate the shared definitions, normals and tessellation identically', () => {
  const directory = fileURLToPath(new URL('../../../../../slaves/cae/', import.meta.url))
  const python = directory + (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
  const fixtures = JSON.parse(
    readFileSync(new URL('../../../../../slaves/cae/tests/fixtures/continuous-geometry.json', import.meta.url), 'utf8'),
  ) as { kind: ContinuousPrimitive; parameters: Record<string, unknown>; surfaces: number[] }[]
  const fiber = normalizeFiber({
    path: {
      start: [1, 2, 3],
      direction: [0, 0, 1],
      segments: [
        { kind: 'line', length: 2 },
        { kind: 'arc', radius: 3, angle: 0.7, normal: [0, 1, 0] },
        { kind: 'arc', radius: 4, angle: -0.4, normal: [0, 1, 0] },
      ],
    },
    radiusProfile: [
      { s: 0, radius: 0.2 },
      { s: 2, radius: 0.3 },
      { s: 5.7, radius: 0.1 },
    ],
  })
  const source = `import json,sys
from app.methods.geometry.continuous import tessellate_primitive,evaluate_differential
from app.methods.geometry.fiber import tessellate_fiber,evaluate_fiber
import numpy as np
fixtures,fiber=json.load(sys.stdin)
result=[]
for item in fixtures:
 p,t,s=tessellate_primitive(item['kind'],item['parameters'],dict(radialSegments=16,meridianSegments=8))
 jets=[evaluate_differential(item['kind'],item['parameters'],surface,.37,.43) for surface in item['surfaces']]
 result.append(dict(points=p,triangles=t,surfaceIndices=s,jets=jets))
p,t,s=tessellate_fiber(fiber,dict(radialSegments=12,pathSegments=11))
result.append(dict(points=p,triangles=t,surfaceIndices=s,jets=[evaluate_fiber(fiber,s,.43) for s in (0,1,2,3,5.7)]))
print(json.dumps(result,default=lambda value:value.tolist() if isinstance(value,np.ndarray) else value))`
  const worker = JSON.parse(
    execFileSync(python, ['-c', source], {
      cwd: directory,
      input: JSON.stringify([fixtures, fiber]),
      encoding: 'utf8',
    }),
  ) as (IndexedSurface & { jets: Record<string, number[] | number>[] })[]
  const meshes = fixtures.map((f) =>
    tessellateContinuousPrimitive(f.kind, f.parameters, { radialSegments: 16, meridianSegments: 8 }),
  )
  meshes.push(tessellateFiber(fiber, { radialSegments: 12, pathSegments: 11 }))
  meshes.forEach((mesh, index) => {
    expect(worker[index].triangles).toEqual(mesh.triangles)
    expect(worker[index].surfaceIndices).toEqual(mesh.surfaceIndices)
    expect(worker[index].points.length).toBe(mesh.points.length)
    mesh.points.forEach((point, i) =>
      point.forEach((value, j) => expect(worker[index].points[i][j]).toBeCloseTo(value, 12)),
    )
  })
  fixtures.forEach((fixture, i) =>
    fixture.surfaces.forEach((surface, j) => {
      const value = evaluateContinuousSurface(fixture.kind, fixture.parameters, surface, 0.37, 0.43)
      for (const key of ['position', 'normal', 'derivativeU', 'derivativeV'] as const)
        value[key].forEach((v, k) => expect((worker[i].jets[j][key] as number[])[k]).toBeCloseTo(v, 12))
    }),
  )
  for (const [i, s] of [0, 1, 2, 3, 5.7].entries()) {
    const value = evaluateFiber(fiber, s, 0.43)
    for (const key of ['center', 'position', 'outward', 'derivativeS', 'derivativeTheta'] as const)
      value[key].forEach((v, k) => expect((worker[fixtures.length].jets[i][key] as number[])[k]).toBeCloseTo(v, 12))
  }
})

it('compiles and evaluates the public Geometry reference examples through generated JSX declarations', async () => {
  const database = fileURLToPath(new URL('../../../../../catalog/caemble_catalog/catalog.sqlite3', import.meta.url))
  const { catalog } = readCatalogExamples(database)
  installCatalogRuntimeSlice(catalog)
  const declarations = fileURLToPath(new URL('../api/', import.meta.url))
  for (const element of cadElementCatalog.filter((item) =>
    ['fiber', 'asphericCylinder', 'ellipsoid', 'hyperboloid', 'paraboloid'].includes(item.tag),
  )) {
    if (!('authoringName' in element)) throw new Error('Primitive authoring name is required')
    const source = `import { experiment, ${element.authoringName} } from '@caemble/core'
export default experiment({lengthUnit:'mm',varsSchema:{},geometry:()=>(${element.example}),recordedData:{}})`
    const compiled = compileNodeCadDocument(
      { 'experiment.tsx': source, 'material.tsx': 'export {}' },
      `reference-${element.tag}`,
      catalog,
      declarations,
    )
    const evaluated = executeCompiledDocument(compiled, {}, 'async def simulate(*, sim, tasks, vars):\n    pass\n')
    const scene = await canonicalGeometryScene(evaluated.scene)
    expect(scene.version).toBe(2)
    expect(scene.roots).toHaveLength(1)
    expect(scene.roots[0].node.kind).toBe(element.tag === 'fiber' ? 'fiber' : 'primitive')
  }
})
