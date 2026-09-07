import { buildArtifactSchema, type BuildArtifact } from '@/contracts/build'
import type { BuiltMeasurement } from '@/lib/cad/execution/measurement'
import type { CadScene } from '@/lib/cad/evaluation/types'

export type ScenePresentation = Readonly<{
  tree: CadScene['tree']
  materials: readonly Pick<CadScene['parts'][number], 'id' | 'material'>[]
}>
export type BuiltArtifactInput = Readonly<{
  measurement: BuiltMeasurement
  presentation?: Readonly<{ experiment: ScenePresentation; tasks: Readonly<Record<string, ScenePresentation>> }>
}>

export function parseBuildArtifact(value: unknown): BuildArtifact {
  const artifact = buildArtifactSchema.parse(value)
  artifact.items.forEach((item, index) => {
    if (item.index !== index + 1 || item.file !== `items/${index + 1}.json`)
      throw new Error('Artifact items must be consecutive and uniquely addressed.')
  })
  return artifact
}

export function parseArtifactInput(value: unknown, artifact: Pick<BuildArtifact, 'source_hash'>): BuiltArtifactInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'measurement' && key !== 'presentation')
  ) {
    throw new Error('Artifact item must contain measurement and optional presentation.')
  }
  if (
    'presentation' in value &&
    (typeof value.presentation !== 'object' || value.presentation === null || Array.isArray(value.presentation))
  ) {
    throw new Error('Artifact presentation must be an object.')
  }
  const item = value as BuiltArtifactInput
  if (
    !item ||
    item.measurement?.kind !== 'measurement' ||
    item.measurement.experiment?.sourceHash !== artifact.source_hash
  ) {
    throw new Error('Artifact input does not match its source hash.')
  }
  return item
}
