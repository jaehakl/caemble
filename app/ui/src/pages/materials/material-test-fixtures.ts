import type { CatalogRuntimeSlice, CatalogRuntimeSliceRequest } from '@/api/catalog'

const quantityKinds = [
  { name: 'test.Scalar', domain: 'test', tensorOrder: 0, opaque: true, applicableUnits: ['{test-scalar}'] },
  {
    name: 'test.Matrix',
    domain: 'test',
    tensorOrder: 2,
    opaque: false,
    applicableUnits: ['{test-matrix}', '{test-matrix-alt}'],
  },
  { name: 'test.HighOrder', domain: 'test', tensorOrder: 4, opaque: true, applicableUnits: ['{test-high}'] },
  { name: 'test.Input', domain: 'test', tensorOrder: 0, opaque: true, applicableUnits: ['{test-input}'] },
  { name: 'test.Output', domain: 'test', tensorOrder: 0, opaque: true, applicableUnits: ['{test-output}'] },
  {
    name: 'test.VectorInput',
    domain: 'test',
    tensorOrder: 1,
    opaque: false,
    applicableUnits: ['{test-vector-input}'],
  },
  {
    name: 'test.VectorOutput',
    domain: 'test',
    tensorOrder: 1,
    opaque: false,
    applicableUnits: ['{test-vector-output}'],
  },
]

const materialParameters = [
  {
    key: 'test.scalar_property',
    domain: 'test',
    labelKo: '테스트 스칼라',
    quantityKind: 'test.Scalar',
    specialQualifiers: [],
  },
  {
    key: 'test.matrix_property',
    domain: 'test',
    labelKo: '테스트 행렬',
    quantityKind: 'test.Matrix',
    specialQualifiers: ['test_condition'],
  },
  {
    key: 'test.high_order_property',
    domain: 'test',
    labelKo: '테스트 고차 텐서',
    quantityKind: 'test.HighOrder',
    specialQualifiers: [],
  },
]

const materialModels = [
  {
    key: 'model.test.scalar_curve',
    labelKo: '테스트 스칼라 곡선',
    kind: 'sampled_relation' as const,
    input: { name: 'input', quantityKind: 'test.Input' },
    output: { name: 'output', quantityKind: 'test.Output' },
    minimumSamples: 2,
    sharedBasis: false,
  },
  {
    key: 'model.test.vector_curve',
    labelKo: '테스트 벡터 곡선',
    kind: 'sampled_relation' as const,
    input: { name: 'input', quantityKind: 'test.VectorInput' },
    output: { name: 'output', quantityKind: 'test.VectorOutput' },
    minimumSamples: 2,
    sharedBasis: true,
  },
]

export const materialTestCatalog: CatalogRuntimeSlice = {
  schemaVersion: 1,
  catalogRevision: 'material-test',
  solvers: [],
  quantityKinds: [...quantityKinds],
  materialParameters: [...materialParameters],
  materialModels: [...materialModels],
  materialGlobalQualifiers: ['test_frame', 'test_condition'],
  warnings: [],
}

export function materialTestRuntimeSlice(request: CatalogRuntimeSliceRequest): CatalogRuntimeSlice {
  const selectedParameters = materialParameters.filter((definition) =>
    request.materialParameters.includes(definition.key),
  )
  const selectedModels = materialModels.filter((definition) => request.materialModels.includes(definition.key))
  const names = new Set(request.quantityKinds)
  selectedParameters.forEach((definition) => names.add(definition.quantityKind))
  selectedModels.forEach((definition) => {
    names.add(definition.input.quantityKind)
    names.add(definition.output.quantityKind)
  })
  return {
    ...materialTestCatalog,
    quantityKinds: quantityKinds.filter((definition) => names.has(definition.name)),
    materialParameters: [...selectedParameters],
    materialModels: [...selectedModels],
  }
}
