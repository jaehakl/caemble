from __future__ import annotations

from typing import Any

from sqlalchemy import ForeignKey, Integer, LargeBinary, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


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
