from fastapi import HTTPException
from sqlalchemy import any_, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import SoftwareTopics, Softwares, Topics
from api.models import SoftwareDeleteResult, SoftwareUpsertItem, SwUpsertBatchResult
from api.utils.embedding import get_text_embedding


SOFTWARE_FIELDS = [
    "name",
    "html_url",
    "abstract",
    "description",
    "language",
    "source_updated_at",
    "repository",
    "citations",
    "license",
]


def _normalize_value_by_column(column_name: str, value):
    column = Softwares.__table__.columns[column_name]
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return None if column.nullable else value
    return value


async def sw_upsert_batch_service(
    db: AsyncSession, payload: list[SoftwareUpsertItem]
) -> SwUpsertBatchResult:
    inserted = 0
    updated = 0
    topics_created = 0
    links_created = 0
    orphan_topic_candidate_ids: set[int] = set()

    for item in payload:
        full_name = item.full_name.strip()
        if not full_name:
            raise HTTPException(status_code=400, detail="full_name is required")

        values = {
            "name": item.name,
            "html_url": item.html_url,
            "abstract": item.abstract,
            "description": item.description,
            "language": item.language,
            "source_updated_at": item.source_updated_at,
            "repository": item.repository,
            "citations": item.citations,
            "license": item.license,
        }
        for key in SOFTWARE_FIELDS:
            values[key] = _normalize_value_by_column(key, values[key])
            column = Softwares.__table__.columns[key]
            if values[key] is None and not column.nullable:
                raise HTTPException(status_code=400, detail=f"{key} is required")

        text_for_embedding = (
            f"{(values['abstract'] or '').strip()} {(values['description'] or '').strip()}"
        ).strip()
        embedding = get_text_embedding(text_for_embedding) if text_for_embedding else None

        software = await db.scalar(
            select(Softwares).where(Softwares.full_name == full_name)
        )
        if software is None:
            software = Softwares(
                full_name=full_name,
                name=values["name"],
                html_url=values["html_url"],
                abstract=values["abstract"],
                description=values["description"],
                language=values["language"],
                source_updated_at=values["source_updated_at"],
                repository=values["repository"],
                citations=values["citations"],
                license=values["license"],
                embedding=embedding,
            )
            db.add(software)
            await db.flush()
            inserted += 1
        else:
            software.name = values["name"]
            software.html_url = values["html_url"]
            software.abstract = values["abstract"]
            software.description = values["description"]
            software.language = values["language"]
            software.source_updated_at = values["source_updated_at"]
            software.repository = values["repository"]
            software.citations = values["citations"]
            software.license = values["license"]
            software.embedding = embedding
            updated += 1

        normalized_topics = {
            topic_name.strip()
            for topic_name in item.topics
            if topic_name and topic_name.strip()
        }

        existing_links = (
            await db.execute(
                select(SoftwareTopics).where(SoftwareTopics.software_id == software.id)
            )
        ).scalars().all()
        existing_topic_ids = {link.topic_id for link in existing_links}

        target_topic_ids: set[int] = set()
        for topic_name in normalized_topics:
            topic = await db.scalar(
                select(Topics).where(topic_name == any_(Topics.alternative_topics))
            )
            if topic is None:
                topic = Topics(topic=topic_name, alternative_topics=[topic_name])
                db.add(topic)
                await db.flush()
                topics_created += 1
            target_topic_ids.add(topic.id)

            if topic.id not in existing_topic_ids:
                db.add(SoftwareTopics(software_id=software.id, topic_id=topic.id))
                links_created += 1

        removed_topic_ids: set[int] = set()
        for link in existing_links:
            if link.topic_id not in target_topic_ids:
                removed_topic_ids.add(link.topic_id)
                await db.delete(link)

        if removed_topic_ids:
            orphan_topic_candidate_ids.update(removed_topic_ids)

    if orphan_topic_candidate_ids:
        await db.flush()
        orphan_topic_ids = (
            await db.execute(
                select(Topics.id).where(
                    Topics.id.in_(orphan_topic_candidate_ids),
                    ~exists(
                        select(SoftwareTopics.topic_id).where(
                            SoftwareTopics.topic_id == Topics.id
                        )
                    ),
                )
            )
        ).scalars().all()
        if orphan_topic_ids:
            orphan_topics = (
                await db.execute(select(Topics).where(Topics.id.in_(orphan_topic_ids)))
            ).scalars().all()
            for orphan_topic in orphan_topics:
                await db.delete(orphan_topic)

    await db.commit()
    return SwUpsertBatchResult(
        inserted=inserted,
        updated=updated,
        topics_created=topics_created,
        links_created=links_created,
    )


async def sw_delete_service(db: AsyncSession, full_name: str) -> SoftwareDeleteResult:
    normalized_full_name = full_name.strip()
    if not normalized_full_name:
        raise HTTPException(status_code=400, detail="full_name is required")

    software = await db.scalar(
        select(Softwares).where(Softwares.full_name == normalized_full_name)
    )
    if software is None:
        raise HTTPException(status_code=404, detail="software not found")

    await db.delete(software)
    await db.flush()

    orphan_topic_ids = (
        await db.execute(
            select(Topics.id).where(
                ~exists(
                    select(SoftwareTopics.topic_id).where(
                        SoftwareTopics.topic_id == Topics.id
                    )
                )
            )
        )
    ).scalars().all()

    deleted_topics = 0
    for topic_id in orphan_topic_ids:
        orphan_topic = await db.get(Topics, topic_id)
        if orphan_topic is not None:
            await db.delete(orphan_topic)
            deleted_topics += 1

    await db.commit()
    return SoftwareDeleteResult(
        deleted_full_name=normalized_full_name,
        deleted_topics=deleted_topics,
    )
