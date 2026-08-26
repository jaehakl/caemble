import type { CanonicalGeometrySceneV1 } from '../evaluation/canonicalTypes'
import type { Vars } from '../model/types'
import type { VarsSchemaEntry } from '../model/vars'
import type { SimulationProgramManifest } from '../simulation/types'
import type { SerializableCadScene } from './meshSerialization'

export type EvaluatedExperimentSnapshot = Readonly<{
  kind: 'experiment'
  sourceHash: string
  variables: Readonly<Vars>
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  scene: CanonicalGeometrySceneV1
  taskScenes: Readonly<Record<string, CanonicalGeometrySceneV1>>
  renderScene: SerializableCadScene
  taskRenderScenes: Readonly<Record<string, SerializableCadScene>>
  simulationProgram: SimulationProgramManifest
}>

export type EvaluatedDocumentSnapshot = EvaluatedExperimentSnapshot
export type MeasurementExperimentSnapshot = Readonly<
  Omit<EvaluatedExperimentSnapshot, 'renderScene' | 'taskRenderScenes'>
>
