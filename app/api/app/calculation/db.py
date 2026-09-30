from __future__ import annotations

from typing import Any, List, Optional

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship


from db import Base, TimestampMixin


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


class CalculationSource(Base):
    """Owned shared definition; every write uses definition revision checks."""
    __tablename__ = "calculation_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_code: Mapped[str] = mapped_column(Text, nullable=False)
    source_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    owner_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1", default=1)


class Calculation(TimestampMixin, Base):
    __tablename__ = "calculations"
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    experiment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("experiments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    validated_source_revision: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    source_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("calculation_sources.id", ondelete="RESTRICT"), nullable=False, index=True,
    )
    source: Mapped["CalculationSource"] = relationship(lazy="selectin")

    @hybrid_property
    def name(self) -> str:
        return self.source.name

    @name.inplace.expression
    @classmethod
    def _name_expression(cls):
        return select(CalculationSource.name).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("name")

    @hybrid_property
    def description(self) -> str | None:
        return self.source.description

    @description.inplace.expression
    @classmethod
    def _description_expression(cls):
        return select(CalculationSource.description).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("description")

    @hybrid_property
    def source_revision(self) -> int:
        return self.source.revision

    @source_revision.inplace.expression
    @classmethod
    def _source_revision_expression(cls):
        return select(CalculationSource.revision).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("source_revision")

    @hybrid_property
    def source_owner_id(self) -> str | None:
        return self.source.owner_id

    @source_owner_id.inplace.expression
    @classmethod
    def _source_owner_id_expression(cls):
        return select(CalculationSource.owner_id).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("source_owner_id")

    @hybrid_property
    def source_code(self) -> str:
        return self.source.source_code

    @source_code.inplace.expression
    @classmethod
    def _source_code_expression(cls):
        return select(CalculationSource.source_code).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("source_code")

    @hybrid_property
    def source_hash(self) -> str:
        return self.source.source_hash

    @source_hash.inplace.expression
    @classmethod
    def _source_hash_expression(cls):
        return select(CalculationSource.source_hash).where(
            CalculationSource.id == cls.source_id,
        ).correlate_except(CalculationSource).scalar_subquery().label("source_hash")

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


class CalculationLegacyMetadata(Base):
    """Revision-17 rollback data, never used for application reads."""
    __tablename__ = "calculation_legacy_metadata"
    calculation_id: Mapped[int] = mapped_column(ForeignKey("calculations.id", ondelete="CASCADE"), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


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
