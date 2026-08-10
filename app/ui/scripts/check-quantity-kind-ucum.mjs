import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { UcumLhcUtils } = require('@lhncbc/ucum-lhc')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'src/lib/cad/api/authoring-manifest.json'), 'utf8'))
const assetPath = path.join(root, `public/assets/quantity-kind-data-${manifest.quantityKindDataVersion}.js`)
const { opaqueQuantityKindNames, quantityKindData } = await import(pathToFileURL(assetPath).href)
const expectedOpaqueNames = [
  'LinearLogarithmicRatio',
  'thermodynamics.AreaTimeTemperature',
  'thermodynamics.LengthTemperatureTime',
  'thermodynamics.TemperatureVariance',
  'chemistry.Acidity',
  'chemistry.Basicity',
]

if (JSON.stringify(opaqueQuantityKindNames) !== JSON.stringify(expectedOpaqueNames)) {
  throw new Error('Generated QuantityKind opaque-unit policy does not match the reviewed exception list.')
}

const opaqueNames = new Set(opaqueQuantityKindNames)
const ucum = UcumLhcUtils.getInstance()
let unitCount = 0
for (const [name, entry] of Object.entries(quantityKindData)) {
  const units = entry.applicableUnits
  if (!Array.isArray(units) || units.length === 0 || new Set(units).size !== units.length) {
    throw new Error(`${name} must contain a non-empty, unique applicableUnits list.`)
  }
  unitCount += units.length
  if (opaqueNames.has(name)) continue
  for (const unit of units) {
    const validation = ucum.validateUnitString(unit, true)
    if (validation.status !== 'valid') {
      throw new Error(`${name} contains non-UCUM applicable unit ${JSON.stringify(unit)}: ${validation.status}`)
    }
  }
}

if (Object.keys(quantityKindData).length !== 1_216 || unitCount !== 10_338) {
  throw new Error(
    `Strict QuantityKind catalog size changed: ${Object.keys(quantityKindData).length} kinds, ${unitCount} units.`,
  )
}

console.log(`Validated ${unitCount} applicable units with @lhncbc/ucum-lhc (six opaque QuantityKinds excluded).`)
