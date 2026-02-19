from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import SoftwareTopics, Topics
from api.models import TopicRead


async def list_topics_service(db: AsyncSession) -> list[TopicRead]:
    count_subquery = (
        select(
            SoftwareTopics.topic_id.label("topic_id"),
            func.count().label("software_count"),
        )
        .group_by(SoftwareTopics.topic_id)
        .subquery()
    )
    rows = await db.execute(
        select(
            Topics.id,
            Topics.topic,
            Topics.alternative_topics,
            func.coalesce(count_subquery.c.software_count, 0),
        )
        .outerjoin(count_subquery, count_subquery.c.topic_id == Topics.id)
        .order_by(Topics.topic.asc())
    )
    return [
        TopicRead(
            id=topic_id,
            topic=topic_name,
            alternative_topics=alternative_topics or [],
            software_count=software_count,
        )
        for topic_id, topic_name, alternative_topics, software_count in rows
    ]
