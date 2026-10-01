from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatasetSelection(RequestModel):
    request_id: UUID
    name: str = Field(min_length=1, max_length=200)
    experiment_id: int = Field(gt=0)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    vars_schema: dict[str, Any]
    record_ids: list[int] = Field(default_factory=list)
    calculation_ids: list[int] = Field(default_factory=list)
    rules: list[dict[str, Any]] = Field(default_factory=list)
    result_contracts: dict[str, Any] = Field(default_factory=dict)
    expected_revision: int | None = Field(default=None, ge=1)

    @field_validator("record_ids", "calculation_ids")
    @classmethod
    def valid_ids(cls, values):
        if any(value <= 0 for value in values) or len(set(values)) != len(values):
            raise ValueError("Selection IDs must be unique positive integers.")
        return sorted(values)


class LocalDatasetRegistration(RequestModel):
    request_id: UUID
    dataset_id: UUID
    revision: int = Field(ge=1)
    expected_revision: int | None = Field(default=None, ge=1)
    name: str = Field(min_length=1, max_length=200)
    experiment_id: int = Field(gt=0)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    storage_id: UUID
    launcher_id: UUID
    sample_count: int = Field(ge=0)
    source_contracts: dict[str, Any]
    verified: bool = True
    payload_available: bool = True


class StorageRegistration(RequestModel):
    storage_id: UUID
    launcher_id: UUID
    name: str = Field(min_length=1, max_length=200)
    job_id: UUID | None = None


class DatasetGrantRequest(RequestModel):
    revision: int = Field(ge=1)


class ModelReserve(RequestModel):
    request_id: UUID
    model_id: UUID | None = None
    expected_revision: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=200)
    direction: Literal["forward", "inverse"]
    dataset_id: UUID
    dataset_revision: int = Field(ge=1)
    definition: dict[str, Any]
    storage_id: UUID
    launcher_id: UUID


class ArtifactFile(RequestModel):
    name: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.-]+$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byteLength: int = Field(ge=0)


class ModelComplete(RequestModel):
    request_id: UUID
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    files: list[ArtifactFile] = Field(min_length=1)
    profile: dict[str, Any]
    input_layouts: Any
    output_layouts: Any
    format_version: Literal[1] = 1
    verified: bool = True


class DeleteRequest(RequestModel):
    request_id: UUID
    storage_id: UUID | None = None
    launcher_id: UUID | None = None


class ModelLeaseRequest(RequestModel):
    job_id: UUID
    revision: int = Field(ge=1)
    replica_id: UUID | None = None
    storage_id: UUID | None = None


class ReplicaRegistration(RequestModel):
    asset_kind: Literal["model", "dataset"]
    asset_id: UUID
    revision: int = Field(ge=1)
    storage_id: UUID
    launcher_id: UUID
    state: Literal["present", "missing", "corrupt"] = "present"
    manifest_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    artifact: dict[str, Any] | None = None


class OperationCreate(RequestModel):
    request_id: UUID
    kind: Literal["backup", "restore", "delete_replica", "delete_asset", "verify"]
    asset_kind: Literal["model", "dataset"] = "model"
    asset_id: UUID
    revision: int | None = Field(default=None, ge=1)
    source_replica_id: UUID | None = None
    source_launcher_id: UUID | None = None
    target_storage_id: UUID | None = None
    target_launcher_id: UUID | None = None
    include_dataset: bool = False
    dataset_source_replica_id: UUID | None = None
    dataset_source_launcher_id: UUID | None = None
    replica_id: UUID | None = None


class ArchiveUpload(RequestModel):
    manifest: dict[str, Any]
    artifact: dict[str, Any]
    dataset: dict[str, Any] | None = None


class OperationComplete(RequestModel):
    model: dict[str, Any] | None = None
    dataset: dict[str, Any] | None = None
    replica_id: UUID | None = None
    receipt: dict[str, Any] | None = None


class AssetRename(RequestModel):
    name: str = Field(min_length=1, max_length=200)
