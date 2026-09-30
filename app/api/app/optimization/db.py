from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base
from user_auth.db import TimestampMixin


class Study(TimestampMixin, Base):
    __tablename__ = "cae_studies"
    __table_args__ = (UniqueConstraint("user_id", "request_id", name="uq_cae_studies_request"),)

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    experiment_id: Mapped[int] = mapped_column(ForeignKey("experiments.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="running", server_default="running")
    pause_reason: Mapped[str | None] = mapped_column(Text)
    definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    optimizer_state: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    best_trial_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Trial(TimestampMixin, Base):
    __tablename__ = "cae_trials"
    __table_args__ = (
        UniqueConstraint("study_id", "ordinal", name="uq_cae_trials_ordinal"),
        UniqueConstraint("study_id", "fingerprint", name="uq_cae_trials_fingerprint"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    study_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("cae_studies.id", ondelete="CASCADE"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    round_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    variables: Mapped[dict] = mapped_column(JSONB, nullable=False)
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="pending", server_default="pending")
    next_stage: Mapped[str] = mapped_column(Text, nullable=False, default="build", server_default="build")
    measurement_id: Mapped[int | None] = mapped_column(ForeignKey("measurements.id", ondelete="RESTRICT"), index=True)
    result: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[dict | None] = mapped_column(JSONB)
    manual_retry_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    retry_request_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    retry_requests: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))


class StageSubmission(TimestampMixin, Base):
    __tablename__ = "cae_stage_submissions"
    __table_args__ = (UniqueConstraint("trial_id", "stage", "generation", name="uq_cae_stage_generation"),)

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    trial_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("cae_trials.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    batch_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("job_batches.id", ondelete="RESTRICT"), unique=True)
    job_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("jobs.id", ondelete="RESTRICT"), unique=True)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="queued", server_default="queued")
    result: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[dict | None] = mapped_column(JSONB)
