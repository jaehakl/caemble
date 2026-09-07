from __future__ import annotations

from typing import Any

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


class CaeBatch(Base):
    __tablename__ = "cae_batches"

    batch_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("job_batches.id", ondelete="CASCADE"), primary_key=True
    )
    experiment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("experiments.id", ondelete="CASCADE"), index=True
    )
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
