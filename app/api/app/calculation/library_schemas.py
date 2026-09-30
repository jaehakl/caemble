from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from calculation.schemas import CalculationOutputLayout
from simulation.contracts import ExperimentRecordContract


class LibraryReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["catalog", "saved", "source"]
    coordinate: str | None = None
    name: str | None = None
    source_id: int | None = Field(default=None, ge=1)
    calculation_id: int | None = Field(default=None, ge=1)


class LibraryQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["all", "catalog", "mine", "demo"] = "all"
    query: str = Field(default="", max_length=500)
    solver_names: list[str] = Field(default_factory=list)
    solver_name: str = ""
    solver_version: str = ""
    concept: str = ""
    unclassified: bool = False
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=30, ge=1, le=100)


class LibrarySolver(BaseModel):
    name: str
    version: str


class LibraryItem(BaseModel):
    source_hash: str = ""
    reference: LibraryReference
    name: str
    description: str | None
    experiment_name: str
    experiment_coordinate: str
    sources: list[Literal["catalog", "mine", "demo"]]
    solvers: list[LibrarySolver]
    concepts: list[str]


class LibraryFacets(BaseModel):
    solvers: list[LibrarySolver]
    concepts: list[str]


class LibraryPage(BaseModel):
    items: list[LibraryItem]
    total: int
    facets: LibraryFacets


class LibraryDetail(LibraryItem):
    source_revision: int | None = None
    source_id: int | None = None
    source_code: str
    inputs: list[ExperimentRecordContract]
    # Ready dependencies are frozen; otherwise records are only candidates for
    # the browser's existing source dependency analyzer.
    inputs_verified: bool
    output_layout: CalculationOutputLayout | None
    preflight_measurement_id: int | None
    contract_status: Literal["ready", "needs_preflight", "unknown"]
