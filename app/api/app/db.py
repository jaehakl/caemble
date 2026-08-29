from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from settings import settings


def make_async_db_url(url: str) -> str:
    if not url:
        return url
    if url.startswith("postgresql+asyncpg://"):
        return url
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql+psycopg2://"):
        return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


DB_URL = make_async_db_url(settings.db_url)
engine = create_async_engine(DB_URL, future=True, pool_pre_ping=True, echo=False)
SessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
)


naming_convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=naming_convention)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Material(TimestampMixin, Base):
    __tablename__ = "materials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    inchi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    color: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="materials")
    names: Mapped[List["MaterialName"]] = relationship(
        back_populates="material",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    parameters: Mapped[List["MaterialParameter"]] = relationship(
        back_populates="material",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class MaterialName(TimestampMixin, Base):
    __tablename__ = "material_names"
    __table_args__ = (
        Index(
            "uq_material_names_public_name",
            "name",
            unique=True,
            postgresql_where=text("user_id IS NULL"),
        ),
        Index(
            "uq_material_names_user_name",
            "user_id",
            "name",
            unique=True,
            postgresql_where=text("user_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    material_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("materials.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="material_names")
    material: Mapped["Material"] = relationship(back_populates="names")


class MaterialParameter(TimestampMixin, Base):
    __tablename__ = "material_parameters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    material_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("materials.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    source: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    version: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    temperature: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pressure: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    frequency: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="material_parameters")
    material: Mapped["Material"] = relationship(back_populates="parameters")
    qualifiers: Mapped[List["MaterialParameterQualifier"]] = relationship(
        back_populates="material_parameter",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class MaterialParameterQualifier(TimestampMixin, Base):
    __tablename__ = "material_parameter_qualifiers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    material_parameter_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("material_parameters.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)

    material_parameter: Mapped["MaterialParameter"] = relationship(back_populates="qualifiers")


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
    source_hash: Mapped[str] = mapped_column(Text, nullable=False)
    code_embedding: Mapped[Optional[List[float]]] = mapped_column(
        Vector(768),
        nullable=True,
        deferred=True,
    )

    user: Mapped["User"] = relationship("User", back_populates="experiments")
    measurements: Mapped[List["Measurement"]] = relationship(
        back_populates="experiment",
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
    material_parameters: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
    )
    recorded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship("User", back_populates="measurements")
    experiment: Mapped["Experiment"] = relationship(back_populates="measurements")
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


class CalculationExperimentRecord(Base):
    __tablename__ = "calculation_experiment_records"

    calculation_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("calculations.id", name="fk_calc_records_calculation", ondelete="CASCADE"),
        primary_key=True,
    )
    experiment_record_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiment_records.id", name="fk_calc_records_record", ondelete="CASCADE"),
        primary_key=True,
    )


class Calculation(TimestampMixin, Base):
    __tablename__ = "calculations"
    __table_args__ = (
        UniqueConstraint(
            "experiment_id",
            "name",
            name="uq_calculations_experiment_id_name",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_code: Mapped[str] = mapped_column(Text, nullable=False)
    source_hash: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    output_layout: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    preflight_measurement_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("measurements.id", ondelete="SET NULL"),
        nullable=True,
    )
    contract_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="needs_preflight",
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="calculations")
    calculation_data: Mapped[List["CalculationData"]] = relationship(
        back_populates="calculation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    experiment_records: Mapped[List["ExperimentRecord"]] = relationship(
        secondary="calculation_experiment_records",
        back_populates="calculations",
        viewonly=True,
    )
    experiment_record_links: Mapped[List["CalculationExperimentRecord"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class CalculationData(TimestampMixin, Base):
    __tablename__ = "calculation_data"
    __table_args__ = (
        UniqueConstraint(
            "calculation_id",
            "measurement_id",
            name="uq_calculation_data_calculation_id_measurement_id",
        ),
        Index("ix_calculation_data_measurement_id", "measurement_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    calculation_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("calculations.id", ondelete="CASCADE"),
        nullable=False,
    )
    measurement_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("measurements.id", ondelete="CASCADE"),
        nullable=False,
    )
    data: Mapped[Any] = mapped_column(JSONB, nullable=False)

    calculation: Mapped["Calculation"] = relationship(back_populates="calculation_data")
    measurement: Mapped["Measurement"] = relationship(back_populates="calculation_data")
