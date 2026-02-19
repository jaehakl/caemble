from __future__ import annotations

from datetime import datetime
from typing import List
from pydantic import BaseModel
from sqlalchemy import (
    MetaData,
    func,
    Text,
    DateTime,
    Integer,
    ForeignKey,
    ARRAY,
)
from pgvector.sqlalchemy import Vector
from sqlalchemy.orm import (
    DeclarativeBase,
    mapped_column,
    Mapped,
    relationship,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.settings import settings


# ---------------------------------------------------------------------
# Database URL & Engine
# ---------------------------------------------------------------------
def make_async_db_url(url: str) -> str:
    if not url:
        return url
    if url.startswith("postgresql+asyncpg://") or url.startswith("sqlite+aiosqlite://"):
        return url
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    if url.startswith("sqlite:///"):
        return url.replace("sqlite:///", "sqlite+aiosqlite:///", 1)
    if url.startswith("sqlite://"):
        return url.replace("sqlite://", "sqlite+aiosqlite://", 1)
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


# ---------------------------------------------------------------------
# Naming convention (good for migrations & consistent constraint names)
# ---------------------------------------------------------------------
naming_convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=naming_convention)


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


# ---------------------------------------------------------------------
# Tables (App Layer)
# ---------------------------------------------------------------------
class Softwares(TimestampMixin, Base):
    __tablename__ = "softwares"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    full_name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    html_url: Mapped[str] = mapped_column(Text, nullable=False)
    abstract: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)
    repository: Mapped[str] = mapped_column(Text, nullable=False)
    citations: Mapped[int] = mapped_column(Integer, nullable=False)
    license: Mapped[str | None] = mapped_column(Text, nullable=True)
    embedding: Mapped[Vector] = mapped_column(Vector(1024), nullable=True, deferred=True)
    software_topics: Mapped[List["SoftwareTopics"]] = relationship("SoftwareTopics",back_populates="software",cascade="all, delete-orphan")

class Topics(TimestampMixin, Base):
    __tablename__ = "topics"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    alternative_topics: Mapped[List[str]] = mapped_column(ARRAY(Text), nullable=True)
    software_topics: Mapped[List["SoftwareTopics"]] = relationship("SoftwareTopics", back_populates="topic", cascade="all, delete-orphan")

class SoftwareTopics(TimestampMixin, Base):
    __tablename__ = "software_topics"
    software_id: Mapped[int] = mapped_column(Integer, ForeignKey("softwares.id", ondelete="CASCADE"), primary_key=True)
    topic_id: Mapped[int] = mapped_column(Integer, ForeignKey("topics.id", ondelete="CASCADE"), primary_key=True)
    software: Mapped["Softwares"] = relationship("Softwares", back_populates="software_topics", lazy="selectin")
    topic: Mapped["Topics"] = relationship("Topics", back_populates="software_topics", lazy="selectin")

