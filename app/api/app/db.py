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


class GeometryRepository(TimestampMixin, Base):
    __tablename__ = "geometry_repositories"
    __table_args__ = (
        UniqueConstraint("namespace", "slug", name="uq_geometry_repositories_namespace_slug"),
        CheckConstraint(
            "slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'",
            name="slug_format",
        ),
        CheckConstraint(
            "namespace ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'",
            name="namespace_format",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    namespace: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="geometry_repositories")
    packages: Mapped[List["GeometryPackage"]] = relationship(
        back_populates="repository",
        passive_deletes=True,
    )


class GeometryPackage(TimestampMixin, Base):
    __tablename__ = "geometry_packages"
    __table_args__ = (
        UniqueConstraint("repository_id", "name", name="uq_geometry_packages_repository_id_name"),
        CheckConstraint(
            "name ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'",
            name="name_format",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    repository_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_repositories.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)

    repository: Mapped["GeometryRepository"] = relationship(back_populates="packages")
    versions: Mapped[List["GeometryVersion"]] = relationship(
        back_populates="package",
        passive_deletes=True,
    )


class GeometryVersion(TimestampMixin, Base):
    __tablename__ = "geometry_versions"
    __table_args__ = (
        UniqueConstraint(
            "package_id",
            "version_major",
            "version_minor",
            "version_patch",
            name="uq_geometry_versions_package_id_semver",
        ),
        CheckConstraint("version_major >= 0", name="version_major_nonnegative"),
        CheckConstraint("version_minor >= 0", name="version_minor_nonnegative"),
        CheckConstraint("version_patch >= 0", name="version_patch_nonnegative"),
        CheckConstraint("source_hash ~ '^[0-9a-f]{64}$'", name="source_hash_sha256"),
        CheckConstraint("module_hash ~ '^[0-9a-f]{64}$'", name="module_hash_sha256"),
        CheckConstraint("module_format_version = 4", name="module_format_version_supported"),
        CheckConstraint("cad_api_version = 7", name="cad_api_version_supported"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    package_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_packages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_major: Mapped[int] = mapped_column(Integer, nullable=False)
    version_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    version_patch: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_hash: Mapped[str] = mapped_column(Text, nullable=False)
    module_hash: Mapped[str] = mapped_column(Text, nullable=False)
    module_format_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="4")
    cad_api_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="7")
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    package: Mapped["GeometryPackage"] = relationship(back_populates="versions")
    imports: Mapped[List["GeometryImport"]] = relationship(
        foreign_keys="GeometryImport.importer_geometry_version_id",
        back_populates="importer",
        passive_deletes=True,
    )
    imported_by: Mapped[List["GeometryImport"]] = relationship(
        foreign_keys="GeometryImport.imported_geometry_version_id",
        back_populates="imported",
        passive_deletes=True,
    )


class GeometryImport(Base):
    __tablename__ = "geometry_imports"
    __table_args__ = (
        CheckConstraint(
            "importer_geometry_version_id <> imported_geometry_version_id",
            name="not_self",
        ),
        CheckConstraint(
            "alias ~ '^[A-Z][A-Za-z0-9_]*$'",
            name="alias_pascal_case",
        ),
        CheckConstraint(
            "export_name ~ '^[A-Z][A-Za-z0-9_]*$'",
            name="export_name_pascal_case",
        ),
    )

    importer_geometry_version_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_versions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    imported_geometry_version_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    export_name: Mapped[str] = mapped_column(Text, nullable=False)
    alias: Mapped[str] = mapped_column(Text, primary_key=True)

    importer: Mapped["GeometryVersion"] = relationship(
        foreign_keys=[importer_geometry_version_id],
        back_populates="imports",
    )
    imported: Mapped["GeometryVersion"] = relationship(
        foreign_keys=[imported_geometry_version_id],
        back_populates="imported_by",
    )


class Experiment(TimestampMixin, Base):
    __tablename__ = "experiments"
    __table_args__ = (
        CheckConstraint(
            "source_hash ~ '^[0-9a-f]{64}$'",
            name="source_hash_sha256",
        ),
    )

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
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_bundle: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    source_hash: Mapped[str] = mapped_column(Text, nullable=False)
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
    measurements: Mapped[List["Measurement"]] = relationship(
        back_populates="experiment",
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
    geometry_imports: Mapped[List["ExperimentGeometryImport"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    geometry_modules: Mapped[List["ExperimentGeometryModule"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ExperimentGeometryImport(Base):
    __tablename__ = "experiment_geometry_imports"
    __table_args__ = (
        CheckConstraint(
            "alias ~ '^[A-Z][A-Za-z0-9_]*$'",
            name="alias_pascal_case",
        ),
        CheckConstraint(
            "export_name ~ '^[A-Z][A-Za-z0-9_]*$'",
            name="export_name_pascal_case",
        ),
    )

    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    alias: Mapped[str] = mapped_column(Text, primary_key=True)
    export_name: Mapped[str] = mapped_column(Text, nullable=False)
    geometry_version_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="geometry_imports")
    geometry_version: Mapped["GeometryVersion"] = relationship()


class ExperimentGeometryModule(Base):
    __tablename__ = "experiment_geometry_modules"

    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    geometry_version_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("geometry_versions.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="geometry_modules")
    geometry_version: Mapped["GeometryVersion"] = relationship()


class Measurement(TimestampMixin, Base):
    __tablename__ = "measurements"
    __table_args__ = (
        CheckConstraint("jsonb_typeof(vars) = 'object'", name="vars_object"),
        CheckConstraint(
            "jsonb_typeof(material_parameters) = 'object'",
            name="material_parameters_object",
        ),
        CheckConstraint(
            "material_parameters ?& ARRAY['schemaVersion', 'experiment', 'tasks'] "
            "AND material_parameters - 'schemaVersion' - 'experiment' - 'tasks' = '{}'::jsonb "
            "AND material_parameters->>'schemaVersion' = '2' "
            "AND jsonb_typeof(material_parameters->'experiment') = 'object' "
            "AND material_parameters->'experiment'->>'schemaVersion' = '1' "
            "AND jsonb_typeof(material_parameters->'experiment'->'materials') = 'object' "
            "AND jsonb_typeof(material_parameters->'tasks') = 'object'",
            name="material_parameters_v2",
        ),
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
        ForeignKey("experiments.id", ondelete="RESTRICT"),
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


class RecordedData(TimestampMixin, Base):
    __tablename__ = "recorded_data"
    __table_args__ = (
        CheckConstraint("tensor_order >= 0", name="tensor_order_nonnegative"),
        CheckConstraint("file_size IS NULL OR file_size >= 0", name="file_size_nonnegative"),
        UniqueConstraint("measurement_id", "name", name="uq_recorded_data_measurement_id_name"),
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
    name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity_kind: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tensor_order: Mapped[int] = mapped_column(Integer, nullable=False)
    dtype: Mapped[str] = mapped_column(Text, nullable=False)
    data_schema: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    data: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    data_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="recorded_data")
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
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="designer_models")
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
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="predictor_models")
    experiment: Mapped["Experiment"] = relationship(back_populates="predictor_models")
