from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


class Dataset(Base):
    __tablename__ = "prediction_datasets"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Provenance survives deletion of the original Experiment.
    experiment_id: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default="active")
    source_kind: Mapped[str] = mapped_column(Text, default="server")
    selection: Mapped[dict] = mapped_column(JSONB)
    current_revision: Mapped[int] = mapped_column(Integer, default=0)
    storage_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    launcher_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    delete_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DatasetRevision(Base):
    __tablename__ = "prediction_dataset_revisions"
    __table_args__ = (UniqueConstraint("dataset_id", "request_id"),)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("prediction_datasets.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(UUID(as_uuid=False))
    request_hash: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(Text)
    summary: Mapped[dict] = mapped_column(JSONB)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DatasetRequest(Base):
    __tablename__ = "prediction_dataset_requests"
    dataset_id: Mapped[str] = mapped_column(ForeignKey("prediction_datasets.id", ondelete="CASCADE"), primary_key=True)
    request_id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text)
    revision: Mapped[int] = mapped_column(Integer)


class DatasetObject(Base):
    __tablename__ = "prediction_dataset_objects"
    __table_args__ = (ForeignKeyConstraint(["dataset_id", "revision"],
        ["prediction_dataset_revisions.dataset_id", "prediction_dataset_revisions.revision"], ondelete="CASCADE"),)
    dataset_id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    object_id: Mapped[str] = mapped_column(ForeignKey("storage_objects.id", ondelete="RESTRICT"), primary_key=True, index=True)


class DatasetGrant(Base):
    __tablename__ = "prediction_dataset_grants"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("prediction_datasets.id", ondelete="CASCADE"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PredictionModel(Base):
    __tablename__ = "prediction_models"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    experiment_id: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(Text)
    direction: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default="active")
    current_revision: Mapped[int] = mapped_column(Integer, default=0)
    storage_id: Mapped[str] = mapped_column(UUID(as_uuid=False))
    launcher_id: Mapped[str] = mapped_column(UUID(as_uuid=False))
    delete_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelRevision(Base):
    __tablename__ = "prediction_model_revisions"
    __table_args__ = (UniqueConstraint("model_id", "request_id"),)
    model_id: Mapped[str] = mapped_column(ForeignKey("prediction_models.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(UUID(as_uuid=False))
    request_hash: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default="reserved")
    dataset_id: Mapped[str] = mapped_column(ForeignKey("prediction_datasets.id", ondelete="RESTRICT"))
    dataset_revision: Mapped[int] = mapped_column(Integer)
    dataset_fingerprint: Mapped[str] = mapped_column(Text)
    definition: Mapped[dict] = mapped_column(JSONB)
    source_contracts: Mapped[dict] = mapped_column(JSONB)
    artifact: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PredictionStorage(Base):
    __tablename__ = "prediction_storages"
    storage_id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    launcher_id: Mapped[str] = mapped_column(UUID(as_uuid=False))
    name: Mapped[str] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelLease(Base):
    __tablename__ = "prediction_model_leases"
    model_id: Mapped[str] = mapped_column(ForeignKey("prediction_models.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True)
