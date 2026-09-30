from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship


from db import Base, TimestampMixin


class ExperimentNamespace(TimestampMixin, Base):
    __tablename__ = "experiment_namespaces"
    __table_args__ = (UniqueConstraint("namespace", "user_id", name="uq_experiment_namespaces_namespace_user_id"),)

    namespace: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    user: Mapped["User"] = relationship("User", back_populates="experiment_namespaces")


class Experiment(TimestampMixin, Base):
    __tablename__ = "experiments"
    __table_args__ = (
        UniqueConstraint(
            "namespace",
            "repository_slug",
            "experiment_key",
            "version_major",
            "version_minor",
            "version_patch",
            name="uq_experiments_coordinate_semver",
        ),
        ForeignKeyConstraint(
            ["namespace", "user_id"],
            ["experiment_namespaces.namespace", "experiment_namespaces.user_id"],
            name="fk_experiments_namespace_user_id_experiment_namespaces",
            ondelete="RESTRICT",
        ),
        Index("ix_experiments_user_id_updated_at", "user_id", "updated_at"),
        Index(
            "ix_experiments_repository_versions",
            "namespace",
            "repository_slug",
            "experiment_key",
            "version_major",
            "version_minor",
            "version_patch",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    namespace: Mapped[str] = mapped_column(Text, nullable=False)
    repository_slug: Mapped[str] = mapped_column(Text, nullable=False)
    experiment_key: Mapped[str] = mapped_column(Text, nullable=False)
    version_major: Mapped[int] = mapped_column(Integer, nullable=False)
    version_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    version_patch: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_bundle: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    result_contracts: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    thumbnail_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    initial_measurement_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("measurements.id", name="fk_experiment_initial_measurement", ondelete="SET NULL", use_alter=True), nullable=True,
    )
    viewer_defaults: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    source_hash: Mapped[str] = mapped_column(Text, nullable=False)
    code_embedding: Mapped[Optional[List[float]]] = mapped_column(
        Vector(768),
        nullable=True,
        deferred=True,
    )

    user: Mapped["User"] = relationship("User", back_populates="experiments")
    measurements: Mapped[List["Measurement"]] = relationship(
        back_populates="experiment",
        foreign_keys="Measurement.experiment_id",
        passive_deletes=True,
    )
    calculations: Mapped[List["Calculation"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    experiment_records: Mapped[List["ExperimentRecord"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    demo: Mapped[Optional["ExperimentDemo"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
        uselist=False,
    )


class ExperimentDemo(TimestampMixin, Base):
    __tablename__ = "experiment_demos"
    __table_args__ = (
        CheckConstraint("display_order >= 0", name="ck_experiment_demos_display_order_nonnegative"),
        UniqueConstraint("display_order", name="uq_experiment_demos_display_order"),
        Index(
            "uq_experiment_demos_single_default",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )

    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    display_order: Mapped[int] = mapped_column(Integer, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))

    experiment: Mapped["Experiment"] = relationship(back_populates="demo")


class ExperimentRecord(TimestampMixin, Base):
    __tablename__ = "experiment_records"
    __table_args__ = (
        UniqueConstraint(
            "experiment_id",
            "name",
            name="uq_experiment_records_experiment_id_name",
        ),
        Index("ix_experiment_records_experiment_id", "experiment_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity_kind: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tensor_order: Mapped[int] = mapped_column(Integer, nullable=False)
    dtype: Mapped[str] = mapped_column(Text, nullable=False)
    data_schema: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    contract_hash: Mapped[str] = mapped_column(Text, nullable=False)

    experiment: Mapped["Experiment"] = relationship(back_populates="experiment_records")
    recorded_data: Mapped[List["RecordedData"]] = relationship(
        back_populates="experiment_record",
        passive_deletes=True,
    )
    calculations: Mapped[List["Calculation"]] = relationship(
        secondary="calculation_experiment_records",
        back_populates="experiment_records",
        viewonly=True,
    )


class Measurement(TimestampMixin, Base):
    __tablename__ = "measurements"
    __table_args__ = (
        Index(
            "ix_measurements_user_id_updated_at",
            "user_id",
            "updated_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    vars: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
    )
    material_snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
    )
    recorded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    job_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("jobs.id", ondelete="SET NULL"), unique=True,
    )

    user: Mapped["User"] = relationship("User", back_populates="measurements")
    experiment: Mapped["Experiment"] = relationship(back_populates="measurements", foreign_keys=[experiment_id])
    recorded_data: Mapped[List["RecordedData"]] = relationship(
        back_populates="measurement",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    calculation_data: Mapped[List["CalculationData"]] = relationship(
        back_populates="measurement",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ExperimentThumbnail(Base):
    __tablename__ = "experiment_thumbnails"
    experiment_id: Mapped[int] = mapped_column(ForeignKey("experiments.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)


class ExperimentSaveReceipt(Base):
    __tablename__ = "experiment_save_receipts"
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    request_id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class MeasurementSnapshot(Base):
    __tablename__ = "measurement_snapshots"
    measurement_id: Mapped[int] = mapped_column(ForeignKey("measurements.id", ondelete="CASCADE"), primary_key=True)
    artifact: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    execution_trace: Mapped[list] = mapped_column(JSONB, nullable=False)


class MeasurementVisualization(TimestampMixin, Base):
    __tablename__ = "measurement_visualizations"

    measurement_id: Mapped[int] = mapped_column(
        ForeignKey("measurements.id", ondelete="CASCADE"), primary_key=True,
    )
    task: Mapped[str] = mapped_column(Text, primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class RecordedData(TimestampMixin, Base):
    __tablename__ = "recorded_data"
    __table_args__ = (
        UniqueConstraint(
            "measurement_id",
            "experiment_record_id",
            name="uq_recorded_data_measurement_id_experiment_record_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    measurement_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("measurements.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    experiment_record_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiment_records.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    data: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    data_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="recorded_data")
    measurement: Mapped["Measurement"] = relationship(back_populates="recorded_data")
    experiment_record: Mapped["ExperimentRecord"] = relationship(back_populates="recorded_data")


class CaeBatch(Base):
    __tablename__ = "cae_batches"

    batch_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("job_batches.id", ondelete="CASCADE"), primary_key=True
    )
    experiment_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("experiments.id", ondelete="CASCADE"), index=True, nullable=True
    )
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class CaeUploadChunk(Base):
    __tablename__ = "cae_upload_chunks"

    job_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
