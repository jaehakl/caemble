from __future__ import annotations

from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from models import ExperimentSourceBundle


class CatalogModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CatalogMeta(CatalogModel):
    schema_version: Literal[4]
    catalog_revision: str
    quantity_kind_data_version: str
    material_catalog_version: str
    quantity_kind_count: int
    material_parameter_count: int
    material_model_count: int
    solver_count: int
    experiment_count: int
    material_global_qualifiers: list[str]
    material_design_rules: dict[str, str]


class QuantityKind(CatalogModel):
    name: str
    domain: str
    tensor_order: int
    description: str | None
    opaque: bool
    applicable_units: list[str]


class MaterialLink(CatalogModel):
    key: str
    label_ko: str


class SolverQuantityKindUsage(CatalogModel):
    solver_name: str
    solver_version: str
    quantity_kind: str | None = None
    context: Literal["parameter", "material", "input", "output", "axis"]
    path: str
    unit: str | None


class QuantityKindDetail(QuantityKind):
    material_parameters: list[MaterialLink]
    solver_usages: list[SolverQuantityKindUsage]


class MaterialParameter(CatalogModel):
    key: str
    domain: str
    label_ko: str
    quantity_kind: str
    special_qualifiers: list[str]


class SolverMaterialRequirement(CatalogModel):
    solver_name: str
    solver_version: str
    role: str
    role_description: str | None = None
    method_category: str
    method_id: str
    material_parameter: str | None = None
    description: str
    quantity_kind: str | None = None
    unit: str | None = None


class MaterialParameterDetail(MaterialParameter):
    quantity_kind_definition: QuantityKind
    solver_requirements: list[SolverMaterialRequirement]


class MaterialModelEndpoint(CatalogModel):
    name: str
    quantity_kind: str


class MaterialModel(CatalogModel):
    key: str
    label_ko: str
    kind: Literal["sampled_relation"]
    input: MaterialModelEndpoint
    output: MaterialModelEndpoint
    minimum_samples: int
    shared_basis: bool


class SolverSummary(CatalogModel):
    name: str
    version: str
    description: str
    contract_digest: str


class ArtifactConsumer(CatalogModel):
    solver_name: str
    solver_version: str
    input_port: str


class ProducedArtifact(CatalogModel):
    method_id: str
    artifact_type: str
    consumers: list[ArtifactConsumer]


class ArtifactProducer(CatalogModel):
    solver_name: str
    solver_version: str
    method_id: str


class ConsumedArtifact(CatalogModel):
    input_port: str
    artifact_type: str
    producers: list[ArtifactProducer]


class SolverDetail(SolverSummary):
    descriptor: dict[str, Any]
    material_requirements: list[SolverMaterialRequirement]
    quantity_kind_usages: list[SolverQuantityKindUsage]
    produces_artifacts: list[ProducedArtifact]
    consumes_artifacts: list[ConsumedArtifact]


class ExperimentSolver(CatalogModel):
    name: str
    version: str
    description: str


class ExperimentSummary(CatalogModel):
    key: str
    namespace: str
    repository: str
    version: str
    coordinate: str
    title: str
    description: str
    cad_api_version: Literal[8]
    source_format_version: Literal[2]
    bundle_format_version: Literal[6]
    bundle_hash: str
    concepts: list[str]
    related_solvers: list[ExperimentSolver]


class VerificationRecord(CatalogModel):
    name: str
    dtype: str
    shape: list[int]
    value: Any
    absolute_tolerance: float


class VerificationTerminal(CatalogModel):
    kind: Literal["complete"]
    sequence: int
    record_sequences: list[int]


class ExperimentFixture(CatalogModel):
    records: list[VerificationRecord]
    terminal: VerificationTerminal


class ExperimentVerification(CatalogModel):
    kernel_tasks: list[str]
    recorded_data: list[str]
    expectations: list[str]
    fixture: ExperimentFixture | None = None


class ExperimentDetail(ExperimentSummary):
    verification: ExperimentVerification
    source_bundle: ExperimentSourceBundle


class CatalogSearchItem(CatalogModel):
    kind: Literal["quantityKind", "materialParameter", "materialModel", "solver", "experiment"]
    key: str
    title: str
    subtitle: str


class CatalogSearchResponse(CatalogModel):
    items: list[CatalogSearchItem]


T = TypeVar("T")


class CatalogPage(CatalogModel, Generic[T]):
    items: list[T]
    next_cursor: str | None
    total: int


CatalogIdentifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class SolverIdentity(CatalogModel):
    name: CatalogIdentifier
    version: CatalogIdentifier


class CatalogRuntimeSliceRequest(BaseModel):
    solvers: list[SolverIdentity] = Field(default_factory=list, max_length=32)
    quantityKinds: list[CatalogIdentifier] = Field(default_factory=list, max_length=256)
    materialParameters: list[CatalogIdentifier] = Field(default_factory=list, max_length=256)
    materialModels: list[CatalogIdentifier] = Field(default_factory=list, max_length=64)


class RuntimeSolver(CatalogModel):
    name: str
    version: str
    contract_digest: str
    descriptor: dict[str, Any]


class CatalogRuntimeSlice(CatalogModel):
    schema_version: Literal[1]
    catalog_revision: str
    solvers: list[RuntimeSolver]
    quantity_kinds: list[QuantityKind]
    material_parameters: list[MaterialParameter]
    material_models: list[MaterialModel]
    material_global_qualifiers: list[str]
    warnings: list[str]
