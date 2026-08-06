from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
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
    "ck": "ck_%(table_name)s_%(constraint_name)s",
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


class Geometry(TimestampMixin, Base):
    __tablename__ = "geometries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("geometries.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    code_embedding: Mapped[Optional[List[float]]] = mapped_column(
        Vector(768),
        nullable=True,
        deferred=True,
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="geometries")
    parent: Mapped[Optional["Geometry"]] = relationship(
        remote_side="Geometry.id",
        back_populates="children",
    )
    children: Mapped[List["Geometry"]] = relationship(
        back_populates="parent",
        passive_deletes=True,
    )


class Structure(TimestampMixin, Base):
    __tablename__ = "structures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("structures.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    code_embedding: Mapped[Optional[List[float]]] = mapped_column(
        Vector(768),
        nullable=True,
        deferred=True,
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="structures")
    parent: Mapped[Optional["Structure"]] = relationship(
        remote_side="Structure.id",
        back_populates="children",
    )
    children: Mapped[List["Structure"]] = relationship(
        back_populates="parent",
        passive_deletes=True,
    )
    samples: Mapped[List["Sample"]] = relationship(
        back_populates="structure",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    designer_models: Mapped[List["DesignerModel"]] = relationship(
        back_populates="structure",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    predictor_models: Mapped[List["PredictorModel"]] = relationship(
        back_populates="structure",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Experiment(TimestampMixin, Base):
    __tablename__ = "experiments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    simulation_code: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    code_embedding: Mapped[Optional[List[float]]] = mapped_column(
        Vector(768),
        nullable=True,
        deferred=True,
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="experiments")
    parent: Mapped[Optional["Experiment"]] = relationship(
        remote_side="Experiment.id",
        back_populates="children",
    )
    children: Mapped[List["Experiment"]] = relationship(
        back_populates="parent",
        passive_deletes=True,
    )
    setups: Mapped[List["Setup"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    designer_models: Mapped[List["DesignerModel"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    predictor_models: Mapped[List["PredictorModel"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Sample(TimestampMixin, Base):
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    structure_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("structures.id", ondelete="CASCADE"),
        nullable=False,
    )
    vars: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    material_parameters: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="samples")
    structure: Mapped["Structure"] = relationship(back_populates="samples")
    measurements: Mapped[List["Measurement"]] = relationship(
        back_populates="sample",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Setup(TimestampMixin, Base):
    __tablename__ = "setups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    vars: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    material_parameters: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="setups")
    experiment: Mapped["Experiment"] = relationship(back_populates="setups")
    measurements: Mapped[List["Measurement"]] = relationship(
        back_populates="setup",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Measurement(TimestampMixin, Base):
    __tablename__ = "measurements"
    __table_args__ = (
        UniqueConstraint(
            "sample_id",
            "setup_id",
            name="uq_measurements_sample_id_setup_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    sample_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("samples.id", ondelete="CASCADE"),
        nullable=False,
    )
    setup_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("setups.id", ondelete="CASCADE"),
        nullable=False,
    )

    user: Mapped[Optional["User"]] = relationship("User", back_populates="measurements")
    sample: Mapped["Sample"] = relationship(back_populates="measurements")
    setup: Mapped["Setup"] = relationship(back_populates="measurements")
    recorded_data: Mapped[List["RecordedData"]] = relationship(
        back_populates="measurement",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class RecordedData(TimestampMixin, Base):
    __tablename__ = "recorded_data"
    __table_args__ = (
        CheckConstraint("tensor_order >= 0", name="tensor_order_nonnegative"),
        CheckConstraint("file_size IS NULL OR file_size >= 0", name="file_size_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    measurement_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("measurements.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity_kind: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tensor_order: Mapped[int] = mapped_column(Integer, nullable=False)
    dtype: Mapped[str] = mapped_column(Text, nullable=False)
    data_schema: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    data: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    data_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="recorded_data")
    measurement: Mapped["Measurement"] = relationship(back_populates="recorded_data")


class DesignerModel(TimestampMixin, Base):
    __tablename__ = "designer_models"
    __table_args__ = (
        CheckConstraint("file_size IS NULL OR file_size >= 0", name="file_size_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    structure_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("structures.id", ondelete="CASCADE"),
        nullable=False,
    )
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="designer_models")
    structure: Mapped["Structure"] = relationship(back_populates="designer_models")
    experiment: Mapped["Experiment"] = relationship(back_populates="designer_models")


class PredictorModel(TimestampMixin, Base):
    __tablename__ = "predictor_models"
    __table_args__ = (
        CheckConstraint("file_size IS NULL OR file_size >= 0", name="file_size_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    structure_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("structures.id", ondelete="CASCADE"),
        nullable=False,
    )
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="predictor_models")
    structure: Mapped["Structure"] = relationship(back_populates="predictor_models")
    experiment: Mapped["Experiment"] = relationship(back_populates="predictor_models")
