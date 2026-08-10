from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    desc,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base
from user_auth.db import TimestampMixin


class APIKey(Base):
    __tablename__ = "api_keys"
    __table_args__ = (
        UniqueConstraint("key_hash", name="uq_api_keys_key_hash"),
        Index("idx_api_keys_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    key_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'user_api'"),
    )
    key_prefix: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    key_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    name: Mapped[Optional[str]] = mapped_column(Text)
    scopes: Mapped[List[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'active'"),
    )
    rate_limit_per_minute: Mapped[Optional[int]] = mapped_column(Integer)
    allowed_ips: Mapped[Optional[List[str]]] = mapped_column(JSONB)
    allowed_origins: Mapped[Optional[List[str]]] = mapped_column(JSONB)
    created_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    last_used_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    user: Mapped["User"] = relationship(back_populates="api_keys")


class Launcher(TimestampMixin, Base):
    __tablename__ = "launchers"
    __table_args__ = (Index("ix_launchers_user_id", "user_id"),)

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    launcher_name: Mapped[str] = mapped_column(Text, nullable=False)
    ip_address: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    slave_app_ids: Mapped[List[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    disconnected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="launchers")
    jobs: Mapped[List["Job"]] = relationship(back_populates="launcher", lazy="raise")


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index(
            "ix_jobs_queued_created",
            "created_at",
            "id",
            postgresql_where=text("state = 'queued'"),
        ),
        Index(
            "ix_jobs_user_queued_created",
            "user_id",
            "created_at",
            "id",
            postgresql_where=text("state = 'queued'"),
        ),
        Index("ix_jobs_user_created_desc", "user_id", desc("created_at"), "id"),
        Index("ix_jobs_created_desc", desc("created_at"), "id"),
        Index("ix_jobs_launcher_state", "launcher_id", "state"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    launcher_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("launchers.id", ondelete="SET NULL"),
    )
    handler_type: Mapped[str] = mapped_column(Text, nullable=False)
    slave_app_id: Mapped[str] = mapped_column(Text, nullable=False)
    offer: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    answer: Mapped[Optional[dict]] = mapped_column(JSONB)
    progress: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    state: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'queued'"),
    )
    assigned_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    answer_ready_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cancel_requested_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    last_error: Mapped[Optional[str]] = mapped_column(Text)
    attempt_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default=text("0"),
    )

    user: Mapped["User"] = relationship(back_populates="jobs")
    launcher: Mapped[Optional[Launcher]] = relationship(back_populates="jobs")
