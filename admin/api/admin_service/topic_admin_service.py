from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import SoftwareTopics, Topics
from api.models import MergeTopicsRequest, MergeTopicsResult, TopicDeleteResult


async def merge_topics_service(
    db: AsyncSession, payload: MergeTopicsRequest
) -> MergeTopicsResult:
    if payload.source_topic_id == payload.target_topic_id:
        raise HTTPException(
            status_code=400, detail="source_topic_id and target_topic_id must differ"
        )
    if payload.keep_topic_id not in {payload.source_topic_id, payload.target_topic_id}:
        raise HTTPException(
            status_code=400,
            detail="keep_topic_id must be one of source_topic_id or target_topic_id",
        )

    source_topic = await db.get(Topics, payload.source_topic_id)
    target_topic = await db.get(Topics, payload.target_topic_id)
    if source_topic is None or target_topic is None:
        raise HTTPException(status_code=404, detail="topic not found")

    kept_topic = (
        source_topic if payload.keep_topic_id == payload.source_topic_id else target_topic
    )
    removed_topic = target_topic if kept_topic.id == source_topic.id else source_topic

    merged_alternatives = []
    for value in (
        kept_topic.alternative_topics or []
    ) + (removed_topic.alternative_topics or []) + [
        kept_topic.topic,
        removed_topic.topic,
    ]:
        normalized = (value or "").strip()
        if normalized and normalized not in merged_alternatives:
            merged_alternatives.append(normalized)
    kept_topic.alternative_topics = merged_alternatives

    existing_kept_software_ids = set(
        (
            await db.execute(
                select(SoftwareTopics.software_id).where(
                    SoftwareTopics.topic_id == kept_topic.id
                )
            )
        ).scalars()
    )
    removed_links = (
        await db.execute(
            select(SoftwareTopics).where(SoftwareTopics.topic_id == removed_topic.id)
        )
    ).scalars()

    links_moved = 0
    links_deduped = 0
    for link in removed_links:
        if link.software_id in existing_kept_software_ids:
            await db.delete(link)
            links_deduped += 1
        else:
            link.topic_id = kept_topic.id
            existing_kept_software_ids.add(link.software_id)
            links_moved += 1

    await db.delete(removed_topic)
    await db.commit()

    return MergeTopicsResult(
        kept_topic_id=kept_topic.id,
        removed_topic_id=removed_topic.id,
        kept_topic=kept_topic.topic,
        alternative_topics=kept_topic.alternative_topics or [],
        links_moved=links_moved,
        links_deduped=links_deduped,
    )


async def delete_topic_service(db: AsyncSession, topic_id: int) -> TopicDeleteResult:
    topic = await db.get(Topics, topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail="topic not found")

    deleted_links = int(
        (
            await db.execute(
                select(func.count()).where(SoftwareTopics.topic_id == topic_id)
            )
        ).scalar_one()
    )
    deleted_topic_name = topic.topic

    await db.delete(topic)
    await db.commit()

    return TopicDeleteResult(
        deleted_topic_id=topic_id,
        deleted_topic=deleted_topic_name,
        deleted_links=deleted_links,
    )
