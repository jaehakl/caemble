from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SoftwareUpsertItem(BaseModel):
    full_name: str
    name: str | None = None
    html_url: str | None = None
    abstract: str | None = None
    description: str | None = None
    language: str | None = None
    source_updated_at: datetime | None = None
    repository: str | None = None
    citations: int | None = None
    license: str | None = None
    topics: list[str] = Field(default_factory=list)


class SwUpsertBatchResult(BaseModel):
    inserted: int
    updated: int
    topics_created: int
    links_created: int


class TopicRead(BaseModel):
    id: int
    topic: str
    alternative_topics: list[str]
    software_count: int


class MergeTopicsRequest(BaseModel):
    source_topic_id: int
    target_topic_id: int
    keep_topic_id: int


class MergeTopicsResult(BaseModel):
    kept_topic_id: int
    removed_topic_id: int
    kept_topic: str
    alternative_topics: list[str]
    links_moved: int
    links_deduped: int


class TopicDeleteResult(BaseModel):
    deleted_topic_id: int
    deleted_topic: str
    deleted_links: int


class SoftwareSearchRequest(BaseModel):
    query: str | None = None
    languages: list[str] = Field(default_factory=list)
    repositories: list[str] = Field(default_factory=list)
    licenses: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    source_updated_at_from: datetime | None = None
    source_updated_at_to: datetime | None = None
    citations_min: int | None = None
    citations_max: int | None = None
    sort_by: Literal["source_updated_at", "citations", "relevance"] = "relevance"
    sort_order: Literal["asc", "desc"] = "desc"
    page: int = 1
    page_size: int = 20


class SoftwareSearchItem(BaseModel):
    id: int
    full_name: str
    name: str | None = None
    abstract: str
    description: str | None = None
    language: str | None = None
    source_updated_at: datetime
    repository: str
    citations: int
    license: str | None = None
    topics: list[str] = Field(default_factory=list)
    relevance_score: int = 0


class SoftwareSearchResult(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int
    sort_by: str
    sort_order: str
    items: list[SoftwareSearchItem]


class SoftwareFilterOptionsResult(BaseModel):
    languages: list[str] = Field(default_factory=list)
    repositories: list[str] = Field(default_factory=list)
    licenses: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    citations_min: int | None = None
    citations_max: int | None = None


class SoftwareDetailItem(BaseModel):
    full_name: str
    name: str | None = None
    html_url: str
    abstract: str
    description: str | None = None
    language: str | None = None
    source_updated_at: datetime
    repository: str
    citations: int
    license: str | None = None
    created_at: datetime
    updated_at: datetime
    topics: list[str] = Field(default_factory=list)


class SimilarSoftwareItem(BaseModel):
    full_name: str
    name: str | None = None
    html_url: str
    abstract: str
    description: str | None = None
    language: str | None = None
    source_updated_at: datetime
    repository: str
    citations: int
    license: str | None = None
    created_at: datetime
    updated_at: datetime
    topics: list[str] = Field(default_factory=list)
    similarity_score: float


class SoftwareDetailResult(BaseModel):
    software: SoftwareDetailItem
    similar_softwares: list[SimilarSoftwareItem] = Field(default_factory=list)


class SoftwareDeleteResult(BaseModel):
    deleted_full_name: str
    deleted_topics: int
