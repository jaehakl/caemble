from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from models import ExperimentSourceBundle


class CatalogModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CatalogMeta(CatalogModel):
    catalog_revision: str
    quantity_kind_data_version: str
    material_catalog_version: str
    quantity_kind_count: int
    material_model_count: int
    solver_count: int
    experiment_count: int


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
    path: str


class SolverQuantityKindUsage(CatalogModel):
    solver_name: str
    solver_version: str
    quantity_kind: str | None = None
    context: str
    path: str
    unit: str | None


class QuantityKindDetail(QuantityKind):
    material_models: list[MaterialLink]
    solver_usages: list[SolverQuantityKindUsage]


class SolverMaterialRequirement(CatalogModel):
    solver_name: str
    solver_version: str
    role: str
    role_description: str | None = None
    method_category: str | None = None
    method_id: str | None = None
    group_key: str
    required: bool
    model: str | None = None


class MaterialModel(CatalogModel):
    key: str
    label_ko: str
    description: str
    equation: str
    conventions: str
    parameter_schema: dict[str, Any]


class MaterialModelDetail(MaterialModel):
    solver_requirements: list[SolverMaterialRequirement]


class SolverSummary(CatalogModel):
    name: str
    version: str
    description: str


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
    bundle_hash: str
    concepts: list[str]
    related_solvers: list[ExperimentSolver]


class ExperimentDetail(ExperimentSummary):
    source_bundle: ExperimentSourceBundle


class CatalogSearchItem(CatalogModel):
    kind: str
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


CatalogIdentifier = str


class SolverIdentity(CatalogModel):
    name: CatalogIdentifier
    version: CatalogIdentifier


class CatalogRuntimeSliceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    solvers: list[SolverIdentity] = Field(default_factory=list)
    quantityKinds: list[CatalogIdentifier] = Field(default_factory=list)
    materialModels: list[CatalogIdentifier] = Field(default_factory=list)


class RuntimeSolver(CatalogModel):
    name: str
    version: str
    descriptor: dict[str, Any]


class CatalogRuntimeSlice(CatalogModel):
    catalog_revision: str
    solvers: list[RuntimeSolver]
    quantity_kinds: list[QuantityKind]
    material_models: list[MaterialModel]
    warnings: list[str]
