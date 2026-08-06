import { generalQuantityKindData } from './data/general'
import { geometryQuantityKindData } from './data/geometry'
import { kinematicsQuantityKindData } from './data/kinematics'
import { mechanicsQuantityKindData } from './data/mechanics'
import { fluidDynamicsQuantityKindData } from './data/fluidDynamics'
import { thermodynamicsQuantityKindData } from './data/thermodynamics'
import { transportQuantityKindData } from './data/transport'
import { electromagnetismQuantityKindData } from './data/electromagnetism'
import { coupledPhenomenaQuantityKindData } from './data/coupledPhenomena'
import { opticsQuantityKindData } from './data/optics'
import { acousticsQuantityKindData } from './data/acoustics'
import { chemistryQuantityKindData } from './data/chemistry'
import { materialsQuantityKindData } from './data/materials'
import { atomicNuclearQuantityKindData } from './data/atomicNuclear'
import { lifeSciencesQuantityKindData } from './data/lifeSciences'
import { earthSpaceQuantityKindData } from './data/earthSpace'
import { informationComputingQuantityKindData } from './data/informationComputing'
import { economicsOperationsQuantityKindData } from './data/economicsOperations'

export const quantityKindDomains = Object.freeze([
  'general',
  'geometry',
  'kinematics',
  'mechanics',
  'fluidDynamics',
  'thermodynamics',
  'transport',
  'electromagnetism',
  'coupledPhenomena',
  'optics',
  'acoustics',
  'chemistry',
  'materials',
  'atomicNuclear',
  'lifeSciences',
  'earthSpace',
  'informationComputing',
  'economicsOperations',
] as const)

const quantityKindDataByDomain = [
  ['general', generalQuantityKindData],
  ['geometry', geometryQuantityKindData],
  ['kinematics', kinematicsQuantityKindData],
  ['mechanics', mechanicsQuantityKindData],
  ['fluidDynamics', fluidDynamicsQuantityKindData],
  ['thermodynamics', thermodynamicsQuantityKindData],
  ['transport', transportQuantityKindData],
  ['electromagnetism', electromagnetismQuantityKindData],
  ['coupledPhenomena', coupledPhenomenaQuantityKindData],
  ['optics', opticsQuantityKindData],
  ['acoustics', acousticsQuantityKindData],
  ['chemistry', chemistryQuantityKindData],
  ['materials', materialsQuantityKindData],
  ['atomicNuclear', atomicNuclearQuantityKindData],
  ['lifeSciences', lifeSciencesQuantityKindData],
  ['earthSpace', earthSpaceQuantityKindData],
  ['informationComputing', informationComputingQuantityKindData],
  ['economicsOperations', economicsOperationsQuantityKindData],
] as const

export const quantityKindData = {
  ...generalQuantityKindData,
  ...geometryQuantityKindData,
  ...kinematicsQuantityKindData,
  ...mechanicsQuantityKindData,
  ...fluidDynamicsQuantityKindData,
  ...thermodynamicsQuantityKindData,
  ...transportQuantityKindData,
  ...electromagnetismQuantityKindData,
  ...coupledPhenomenaQuantityKindData,
  ...opticsQuantityKindData,
  ...acousticsQuantityKindData,
  ...chemistryQuantityKindData,
  ...materialsQuantityKindData,
  ...atomicNuclearQuantityKindData,
  ...lifeSciencesQuantityKindData,
  ...earthSpaceQuantityKindData,
  ...informationComputingQuantityKindData,
  ...economicsOperationsQuantityKindData,
} as const

const domainEntryCount = quantityKindDataByDomain.reduce((count, [, data]) => count + Object.keys(data).length, 0)
if (Object.keys(quantityKindData).length !== domainEntryCount) {
  throw new Error('QuantityKind names must be unique across physical domains.')
}
if (domainEntryCount !== 1_216) {
  throw new Error(`QuantityKind data must contain exactly 1,216 entries; found ${domainEntryCount}.`)
}

const baseNames = new Set<string>()
for (const [domain, data] of quantityKindDataByDomain) {
  for (const [name, entry] of Object.entries(data)) {
    const expectedPrefix = domain === 'general' ? '' : `${domain}.`
    const baseName = expectedPrefix ? name.slice(expectedPrefix.length) : name
    if (
      entry.domain !== domain ||
      (expectedPrefix ? !name.startsWith(expectedPrefix) : name.includes('.')) ||
      baseName.length === 0 ||
      baseName.includes('.')
    ) {
      throw new Error(`QuantityKind ${name} does not match domain ${domain}.`)
    }
    if (baseNames.has(baseName)) {
      throw new Error(`QuantityKind base name ${baseName} is defined more than once.`)
    }
    baseNames.add(baseName)
    Object.freeze(entry.applicableUnits)
    Object.freeze(entry)
  }
  Object.freeze(data)
}
Object.freeze(quantityKindData)
