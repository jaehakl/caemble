from __future__ import annotations

import enum, uuid
from datetime import datetime
from typing import Optional, List
from sqlalchemy import (func,
    text,Text,Boolean,DateTime,LargeBinary,Integer,
    UniqueConstraint,CheckConstraint,ForeignKey,Index,desc,)
from sqlalchemy.orm import (mapped_column,Mapped,relationship,)
from sqlalchemy.dialects.postgresql import (UUID,JSONB,INET)
from sqlalchemy import Enum as SAEnum

from db import Base

# ---------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------
class OAuthProvider(enum.Enum):
    google = "google"
    github = "github"
    kakao = "kakao"
    naver = "naver"
    apple = "apple"

oauth_provider_enum = SAEnum(
    OAuthProvider,
    name="oauth_provider",
    native_enum=True,
    create_type=True,  # create the enum type in PostgreSQL if not exists
)
# ---------------------------------------------------------------------
# Mixins
# ---------------------------------------------------------------------
class TimestampMixin:
    created_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)
    email_verified_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    display_name: Mapped[Optional[str]] = mapped_column(Text)
    picture_url: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    identities: Mapped[List["Identity"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="selectin")
    sessions: Mapped[List["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="selectin")
    user_roles: Mapped[List["UserRole"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="selectin")
    auth_audits: Mapped[List["AuthAudit"]] = relationship(back_populates="user", lazy="selectin")
    api_keys: Mapped[List["APIKey"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="selectin")
    launchers: Mapped[List["Launcher"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="raise")
    jobs: Mapped[List["Job"]] = relationship(back_populates="user", cascade="all, delete-orphan", lazy="raise")
    materials: Mapped[List["Material"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    material_names: Mapped[List["MaterialName"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    material_parameters: Mapped[List["MaterialParameter"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    geometries: Mapped[List["Geometry"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    structures: Mapped[List["Structure"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    experiments: Mapped[List["Experiment"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    samples: Mapped[List["Sample"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    setups: Mapped[List["Setup"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    measurements: Mapped[List["Measurement"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    recorded_data: Mapped[List["RecordedData"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    designer_models: Mapped[List["DesignerModel"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)
    predictor_models: Mapped[List["PredictorModel"]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)

class Identity(TimestampMixin, Base):
    __tablename__ = "identities"
    __table_args__ = (
        UniqueConstraint("provider", "provider_user_id", name="uq_identities_provider_provider_user_id"),
        Index("idx_identities_user_id", "user_id"),
    )
    id: Mapped[str] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[OAuthProvider] = mapped_column(oauth_provider_enum, nullable=False)
    provider_user_id: Mapped[str] = mapped_column(Text, nullable=False)  # OIDC 'sub'
    email: Mapped[Optional[str]] = mapped_column(Text)
    email_verified: Mapped[Optional[bool]] = mapped_column(Boolean)
    raw_profile: Mapped[Optional[dict]] = mapped_column(JSONB)
    user: Mapped[User] = relationship(back_populates="identities")


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        Index("idx_sessions_user_id", "user_id"),
        UniqueConstraint("session_id_hash", name="uq_sessions_session_id_hash"),
    )
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # store only hash
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ip: Mapped[Optional[str]] = mapped_column(INET)
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    revoked_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    user: Mapped[User] = relationship(back_populates="sessions")


class OAuthState(Base):
    __tablename__ = "oauth_states"
    __table_args__ = (
        Index("idx_oauth_states_created_at", "created_at"),
        UniqueConstraint("state", name="uq_oauth_states_state"),
    )
    id: Mapped[str] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider: Mapped[OAuthProvider] = mapped_column(oauth_provider_enum, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)  # CSRF
    nonce: Mapped[Optional[str]] = mapped_column(Text)        # OIDC
    code_verifier: Mapped[Optional[str]] = mapped_column(Text)  # PKCE
    redirect_uri: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    consumed_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))


class AuthAudit(Base):
    __tablename__ = "auth_audit"
    __table_args__ = (
        Index("idx_auth_audit_user_id", "user_id"),
        CheckConstraint(
            "event IN ("
            "'login_success','login_failure','logout','link_success','unlink',"
            "'token_created','token_revoked','token_imported',"
            "'launcher_connected','launcher_rejected','launcher_disconnected'"
            ")",
            name="ck_auth_audit_event",
        ),
    )
    id: Mapped[str] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    provider: Mapped[Optional[OAuthProvider]] = mapped_column(oauth_provider_enum)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    ip: Mapped[Optional[str]] = mapped_column(INET)
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    details: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user: Mapped[Optional["User"]] = relationship(back_populates="auth_audits")


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    user_roles: Mapped[List["UserRole"]] = relationship(back_populates="role", cascade="all, delete-orphan", lazy="selectin")

class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_user_roles_user_id_role_id"),)
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[int] = mapped_column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[Role] = relationship(back_populates="user_roles")
    user: Mapped[User] = relationship(back_populates="user_roles")

class APIKey(Base):
    __tablename__ = "api_keys"
    __table_args__ = (
        UniqueConstraint("key_hash", name="uq_api_keys_key_hash"),
        Index("idx_api_keys_user_id", "user_id"),
    )
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key_type: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'user_api'"))
    key_prefix: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    key_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # store only hash
    name: Mapped[Optional[str]] = mapped_column(Text)
    scopes: Mapped[List[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    rate_limit_per_minute: Mapped[Optional[int]] = mapped_column(Integer)
    allowed_ips: Mapped[Optional[List[str]]] = mapped_column(JSONB)
    allowed_origins: Mapped[Optional[List[str]]] = mapped_column(JSONB)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True))
    user: Mapped["User"] = relationship(back_populates="api_keys")


class Launcher(TimestampMixin, Base):
    __tablename__ = "launchers"
    __table_args__ = (Index("ix_launchers_user_id", "user_id"),)

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    launcher_name: Mapped[str] = mapped_column(Text, nullable=False)
    ip_address: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    slave_app_ids: Mapped[List[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    disconnected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="launchers")
    jobs: Mapped[List["Job"]] = relationship(back_populates="launcher", lazy="raise")


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_queued_created", "created_at", "id", postgresql_where=text("state = 'queued'")),
        Index("ix_jobs_user_queued_created", "user_id", "created_at", "id", postgresql_where=text("state = 'queued'")),
        Index("ix_jobs_user_created_desc", "user_id", desc("created_at"), "id"),
        Index("ix_jobs_created_desc", desc("created_at"), "id"),
        Index("ix_jobs_launcher_state", "launcher_id", "state"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
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
    offer: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    answer: Mapped[Optional[dict]] = mapped_column(JSONB)
    progress: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'queued'"))
    assigned_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    answer_ready_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cancel_requested_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[Optional[str]] = mapped_column(Text)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    user: Mapped[User] = relationship(back_populates="jobs")
    launcher: Mapped[Optional[Launcher]] = relationship(back_populates="jobs")
