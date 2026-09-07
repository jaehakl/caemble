import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { CatalogExperimentDetail, CatalogRuntimeSlice } from '../src/contracts/catalog'
import type { CompiledCadDocument } from '../src/lib/cad/compiler/types'
import { compileNodeCadDocument } from '../src/platform/node/cadCompiler'

export function readCatalogExamples(database: string) {
  return JSON.parse(
    execFileSync(
      'python',
      [
        '-X',
        'utf8',
        '-c',
        `
import sys,json
sys.path.insert(0,sys.argv[2])
from caemble_catalog import open_catalog
with open_catalog(sys.argv[1]) as c:
 solvers=c.list_solvers()
 runtime=c.runtime_slice(
  solvers=[(s['name'],s['version']) for s in solvers],
  quantity_kinds=[q['name'] for q in c.list_quantity_kinds(limit=10000)[0]],
  material_parameters=[m['key'] for m in c.list_material_parameters(limit=10000)[0]],
  material_models=[m['key'] for m in c.list_material_models(limit=10000)[0]])
 examples=[c.experiment(e['coordinate']) for e in c.list_experiments(limit=10000)[0]]
 print(json.dumps(dict(examples=examples,catalog=runtime)))
`,
        database,
        path.resolve('../catalog'),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  ) as { examples: CatalogExperimentDetail[]; catalog: CatalogRuntimeSlice }
}

export function compileCatalogExample(
  example: CatalogExperimentDetail,
  catalog: CatalogRuntimeSlice,
): CompiledCadDocument {
  return compileNodeCadDocument(
    example.sourceBundle.files,
    example.bundleHash,
    catalog,
    path.resolve('src/lib/cad/api'),
  )
}
