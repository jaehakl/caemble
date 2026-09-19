// @vitest-environment node
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { compileCatalogExample, readCatalogExamples } from '../../../../scripts/catalog-example-support'
import { installCatalogRuntimeSlice } from '../../catalog/runtime'
import { cadElementDefinitions } from '../evaluation/registry'
import { varsTensorFromFlat } from '../model/tensor'
import { executeCompiledDocument, inspectCompiledDocument, prepareCompiledPrediction } from './userModule'

afterEach(() => vi.restoreAllMocks())

it('prepares real Catalog BoxGrids with full-evaluation parity and no solid builds', () => {
  const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
  installCatalogRuntimeSlice(catalog)
  for (const suffix of ['matched-impedance-duct', 'pixel-monochromatic-response']) {
    const example = examples.find((value) => value.coordinate.includes(`/${suffix}@`))!
    expect(example).toBeTruthy()
    const compiled = compileCatalogExample(example, catalog)
    const { varsSchema } = inspectCompiledDocument(compiled)
    for (const fraction of [0.4, 0.6]) {
      const vars = Object.fromEntries(
        Object.entries(varsSchema).map(([name, entry]) => [
          name,
          varsTensorFromFlat(
            Array(entry.shape.reduce((count, value) => count * value, 1)).fill(
              entry.min + fraction * (entry.max - entry.min),
            ),
            entry.shape,
          ),
        ]),
      )
      const source = example.sourceBundle.files['simulate.py']
      const full = executeCompiledDocument(compiled, vars, source)
      const records = Object.keys(full.simulationProgram.resultContracts)
      expect(records.length).toBeGreaterThan(0)
      for (const definition of cadElementDefinitions) {
        if (definition.kind !== 'primitive') continue
        vi.spyOn(definition, 'createGeometry').mockImplementation(() => {
          throw new Error('Unexpected solid build')
        })
        vi.spyOn(definition, 'createSurfaces').mockImplementation(() => {
          throw new Error('Unexpected tessellation')
        })
      }
      const prediction = prepareCompiledPrediction(compiled, vars, source, records)
      expect(prediction.simulationProgram.boxGrids).toEqual(full.simulationProgram.boxGrids)
      expect(prediction.simulationProgram.recordedData).toEqual(full.simulationProgram.recordedData)
      expect(prediction.simulationProgram.resultContracts).toEqual(full.simulationProgram.resultContracts)
      expect(prediction).not.toHaveProperty('renderScene')
      const subset = prepareCompiledPrediction(compiled, vars, source, records.slice(0, 1))
      expect(Object.keys(subset.simulationProgram.boxGrids!)).toEqual(records.slice(0, 1))
      vi.restoreAllMocks()
    }
  }
}, 30_000)
