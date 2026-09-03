import type { CadScene } from '../../evaluation/types'
import type { ExperimentParameter, ExperimentTarget } from '../../model/descriptor'
import type { KernelArtifactDataSpec, KernelArtifactType } from '@/contracts/solver'

export type {
  KernelArtifactDataSpec,
  KernelArtifactType,
  KernelDataAxis,
  KernelDataSpec,
  KernelDescriptor,
  KernelInputPortDescriptor,
  KernelMaterialDescriptor,
  KernelMethodDescriptor,
  KernelObservationDescriptor,
  KernelOutputMethodDescriptor,
  KernelParameterDescriptor,
  KernelStructuredBundleSpec,
  KernelTargetDescriptor,
  KernelValueSpec,
} from '@/contracts/solver'

export type KernelMethodCall = Readonly<{
  methodId: string
  target: readonly ExperimentTarget[]
  parameters: Readonly<Record<string, ExperimentParameter>>
}>

export type KernelOutputRequest = KernelMethodCall &
  Readonly<{
    key: string
  }>

export type KernelTaskConfig = Readonly<{
  parameters: Readonly<Record<string, ExperimentParameter>>
  initializations: readonly KernelMethodCall[]
  boundaryConditions: readonly KernelMethodCall[]
  outputs: readonly KernelOutputRequest[]
}>

export type KernelWorld = Readonly<{
  scenes: Readonly<{
    experiment: CadScene
    task: CadScene
  }>
}>

export type ResolvedKernelOutputSpec = Readonly<{
  artifactType: KernelArtifactType
  data: KernelArtifactDataSpec
}>

export type KernelContractIssue = Readonly<{
  path: string
  message: string
}>
