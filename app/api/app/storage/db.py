from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


class StorageObject(Base):
    __tablename__ = "storage_objects"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"))
    experiment_id: Mapped[int | None] = mapped_column(ForeignKey("experiments.id", ondelete="SET NULL"), index=True)
    measurement_id: Mapped[int | None] = mapped_column(ForeignKey("measurements.id", ondelete="SET NULL"), index=True)
    calculation_id: Mapped[int | None] = mapped_column(ForeignKey("calculations.id", ondelete="SET NULL"), index=True)
    calculation_data_id: Mapped[int | None] = mapped_column(ForeignKey("calculation_data.id", ondelete="SET NULL"), index=True)
    job_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("jobs.id", ondelete="SET NULL"), index=True)
    attempt: Mapped[int | None] = mapped_column(Integer)
    purpose: Mapped[str] = mapped_column(Text)
    manifest: Mapped[dict] = mapped_column(JSONB)
    ready: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    bound: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    deleting: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
