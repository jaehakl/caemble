from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import SoftwareTopics, Softwares, Topics
from api.models import SoftwareUpsertItem, SwUpsertBatchResult
from api.utils.embedding import get_text_embedding


async def sw_upsert_batch_service(
    db: AsyncSession, payload: list[SoftwareUpsertItem]
) -> SwUpsertBatchResult:
    inserted = 0
    updated = 0
    topics_created = 0
    links_created = 0

    for item in payload:
        full_name = item.full_name.strip()
        if not full_name:
            raise HTTPException(status_code=400, detail="full_name is required")
        text_for_embedding = f"{item.abstract} {item.description}".strip()
        embedding = get_text_embedding(text_for_embedding)

        software = await db.scalar(
            select(Softwares).where(Softwares.full_name == full_name)
        )
        if software is None:
            software = Softwares(
                full_name=full_name,
                name=item.name,
                html_url=item.html_url,
                abstract=item.abstract,
                description=item.description,
                language=item.language,
                source_updated_at=item.source_updated_at,
                repository=item.repository,
                citations=item.citations,
                license=item.license,
                embedding=embedding,
            )
            db.add(software)
            await db.flush()
            inserted += 1
        else:
            software.name = item.name
            software.html_url = item.html_url
            software.abstract = item.abstract
            software.description = item.description
            software.language = item.language
            software.source_updated_at = item.source_updated_at
            software.repository = item.repository
            software.citations = item.citations
            software.license = item.license
            software.embedding = embedding
            updated += 1

        normalized_topics = {
            topic_name.strip()
            for topic_name in item.topics
            if topic_name and topic_name.strip()
        }

        for topic_name in normalized_topics:
            topic = await db.scalar(select(Topics).where(Topics.topic == topic_name))
            if topic is None:
                topic = Topics(topic=topic_name)
                db.add(topic)
                await db.flush()
                topics_created += 1

            link = await db.scalar(
                select(SoftwareTopics).where(
                    SoftwareTopics.software_id == software.id,
                    SoftwareTopics.topic_id == topic.id,
                )
            )
            if link is None:
                db.add(SoftwareTopics(software_id=software.id, topic_id=topic.id))
                links_created += 1

    await db.commit()
    return SwUpsertBatchResult(
        inserted=inserted,
        updated=updated,
        topics_created=topics_created,
        links_created=links_created,
    )
