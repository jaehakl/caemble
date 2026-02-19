from datetime import datetime

from pydantic import BaseModel, Field


class SoftwareUpsertItem(BaseModel):
    full_name: str
    name: str
    html_url: str
    abstract: str
    description: str
    language: str
    source_updated_at: datetime
    repository: str
    citations: int
    license: str
    topics: list[str] = Field(default_factory=list)


class SwUpsertBatchResult(BaseModel):
    inserted: int
    updated: int
    topics_created: int
    links_created: int
