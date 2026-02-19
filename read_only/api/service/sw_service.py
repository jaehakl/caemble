from math import ceil

from fastapi import HTTPException
from sqlalchemy import any_, case, exists, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from api.db import SoftwareTopics, Softwares, Topics
from api.models import (
    SimilarSoftwareItem,
    SoftwareDetailItem,
    SoftwareDetailResult,
    SoftwareFilterOptionsResult,
    SoftwareSearchItem,
    SoftwareSearchRequest,
    SoftwareSearchResult,
)


def _normalize_string_list(values: list[str]) -> list[str]:
    return [value.strip() for value in values if isinstance(value, str) and value.strip()]


async def sw_search_service(
    db: AsyncSession, payload: SoftwareSearchRequest
) -> SoftwareSearchResult:
    if payload.page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if payload.page_size < 1 or payload.page_size > 100:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 100")
    if payload.citations_min is not None and payload.citations_max is not None:
        if payload.citations_min > payload.citations_max:
            raise HTTPException(
                status_code=400, detail="citations_min must be <= citations_max"
            )
    if payload.source_updated_at_from and payload.source_updated_at_to:
        if payload.source_updated_at_from > payload.source_updated_at_to:
            raise HTTPException(
                status_code=400,
                detail="source_updated_at_from must be <= source_updated_at_to",
            )

    filters = []
    languages = _normalize_string_list(payload.languages)
    repositories = _normalize_string_list(payload.repositories)
    licenses = _normalize_string_list(payload.licenses)
    topics = _normalize_string_list(payload.topics)

    if languages:
        filters.append(func.lower(Softwares.language).in_([value.lower() for value in languages]))
    if repositories:
        filters.append(
            func.lower(Softwares.repository).in_([value.lower() for value in repositories])
        )
    if licenses:
        filters.append(func.lower(Softwares.license).in_([value.lower() for value in licenses]))
    if payload.source_updated_at_from is not None:
        filters.append(Softwares.source_updated_at >= payload.source_updated_at_from)
    if payload.source_updated_at_to is not None:
        filters.append(Softwares.source_updated_at <= payload.source_updated_at_to)
    if payload.citations_min is not None:
        filters.append(Softwares.citations >= payload.citations_min)
    if payload.citations_max is not None:
        filters.append(Softwares.citations <= payload.citations_max)

    if topics:
        topic_match_conditions = [Topics.topic.in_(topics)]
        topic_match_conditions.extend(
            [value == any_(Topics.alternative_topics) for value in topics]
        )
        filters.append(
            exists(
                select(SoftwareTopics.software_id)
                .join(Topics, Topics.id == SoftwareTopics.topic_id)
                .where(
                    SoftwareTopics.software_id == Softwares.id,
                    or_(*topic_match_conditions),
                )
            )
        )

    keyword = (payload.query or "").strip()
    pattern = f"%{keyword}%"
    if keyword:
        filters.append(
            or_(
                Softwares.full_name.ilike(pattern),
                Softwares.name.ilike(pattern),
                Softwares.abstract.ilike(pattern),
                Softwares.description.ilike(pattern),
            )
        )

    relevance_expr = (
        case((Softwares.full_name.ilike(pattern), 4), else_=0)
        + case((Softwares.name.ilike(pattern), 3), else_=0)
        + case((Softwares.abstract.ilike(pattern), 2), else_=0)
        + case((Softwares.description.ilike(pattern), 1), else_=0)
        if keyword
        else literal(0)
    ).label("relevance_score")

    count_stmt = select(func.count()).select_from(
        select(Softwares.id).where(*filters).subquery()
    )
    total = (await db.scalar(count_stmt)) or 0
    total_pages = ceil(total / payload.page_size) if total else 0

    query_stmt = select(
        Softwares.id,
        Softwares.full_name,
        Softwares.name,
        Softwares.abstract,
        Softwares.description,
        Softwares.language,
        Softwares.source_updated_at,
        Softwares.repository,
        Softwares.citations,
        Softwares.license,
        relevance_expr,
    ).where(*filters)

    if payload.sort_by == "source_updated_at":
        order_col = Softwares.source_updated_at
    elif payload.sort_by == "citations":
        order_col = Softwares.citations
    else:
        order_col = relevance_expr

    if payload.sort_order == "asc":
        query_stmt = query_stmt.order_by(order_col.asc(), Softwares.full_name.asc())
    else:
        query_stmt = query_stmt.order_by(order_col.desc(), Softwares.full_name.asc())

    query_stmt = query_stmt.offset((payload.page - 1) * payload.page_size).limit(
        payload.page_size
    )
    rows = (await db.execute(query_stmt)).all()

    software_ids = [row.id for row in rows]
    topics_by_software: dict[int, list[str]] = {software_id: [] for software_id in software_ids}
    if software_ids:
        topic_rows = (
            await db.execute(
                select(SoftwareTopics.software_id, Topics.topic)
                .join(Topics, Topics.id == SoftwareTopics.topic_id)
                .where(SoftwareTopics.software_id.in_(software_ids))
                .order_by(Topics.topic.asc())
            )
        ).all()
        for software_id, topic in topic_rows:
            topics_by_software.setdefault(software_id, []).append(topic)

    items = [
        SoftwareSearchItem(
            id=row.id,
            full_name=row.full_name,
            name=row.name,
            abstract=row.abstract,
            description=row.description,
            language=row.language,
            source_updated_at=row.source_updated_at,
            repository=row.repository,
            citations=row.citations,
            license=row.license,
            topics=topics_by_software.get(row.id, []),
            relevance_score=int(row.relevance_score or 0),
        )
        for row in rows
    ]

    return SoftwareSearchResult(
        page=payload.page,
        page_size=payload.page_size,
        total=total,
        total_pages=total_pages,
        sort_by=payload.sort_by,
        sort_order=payload.sort_order,
        items=items,
    )


async def sw_filter_options_service(db: AsyncSession) -> SoftwareFilterOptionsResult:
    language_rows = (
        await db.execute(
            select(Softwares.language)
            .where(Softwares.language.is_not(None), Softwares.language != "")
            .distinct()
            .order_by(Softwares.language.asc())
        )
    ).scalars().all()
    repository_rows = (
        await db.execute(
            select(Softwares.repository)
            .where(Softwares.repository.is_not(None), Softwares.repository != "")
            .distinct()
            .order_by(Softwares.repository.asc())
        )
    ).scalars().all()
    license_rows = (
        await db.execute(
            select(Softwares.license)
            .where(Softwares.license.is_not(None), Softwares.license != "")
            .distinct()
            .order_by(Softwares.license.asc())
        )
    ).scalars().all()
    topic_rows = (
        await db.execute(select(Topics.topic).where(Topics.topic.is_not(None)).order_by(Topics.topic.asc()))
    ).scalars().all()
    citations_min, citations_max = (
        await db.execute(select(func.min(Softwares.citations), func.max(Softwares.citations)))
    ).one()

    return SoftwareFilterOptionsResult(
        languages=[value for value in language_rows if value],
        repositories=[value for value in repository_rows if value],
        licenses=[value for value in license_rows if value],
        topics=[value for value in topic_rows if value],
        citations_min=citations_min,
        citations_max=citations_max,
    )


async def sw_detail_service(db: AsyncSession, full_name: str) -> SoftwareDetailResult:
    normalized_full_name = full_name.strip()
    if not normalized_full_name:
        raise HTTPException(status_code=400, detail="full_name is required")

    software = await db.scalar(
        select(Softwares)
        .options(undefer(Softwares.embedding))
        .where(Softwares.full_name == normalized_full_name)
    )
    if software is None:
        raise HTTPException(status_code=404, detail="software not found")

    software_topics = (
        await db.execute(
            select(Topics.topic)
            .join(SoftwareTopics, SoftwareTopics.topic_id == Topics.id)
            .where(SoftwareTopics.software_id == software.id)
            .order_by(Topics.topic.asc())
        )
    ).scalars().all()

    similar_softwares: list[SimilarSoftwareItem] = []
    if software.embedding is not None:
        distance_expr = Softwares.embedding.cosine_distance(software.embedding).label("distance")
        similar_rows = (
            await db.execute(
                select(
                    Softwares.id,
                    Softwares.full_name,
                    Softwares.name,
                    Softwares.html_url,
                    Softwares.abstract,
                    Softwares.description,
                    Softwares.language,
                    Softwares.source_updated_at,
                    Softwares.repository,
                    Softwares.citations,
                    Softwares.license,
                    Softwares.created_at,
                    Softwares.updated_at,
                    distance_expr,
                )
                .where(
                    Softwares.id != software.id,
                    Softwares.embedding.is_not(None),
                )
                .order_by(distance_expr.asc(), Softwares.full_name.asc())
                .limit(6)
            )
        ).all()

        similar_ids = [row.id for row in similar_rows]
        topics_by_software: dict[int, list[str]] = {software_id: [] for software_id in similar_ids}
        if similar_ids:
            similar_topic_rows = (
                await db.execute(
                    select(SoftwareTopics.software_id, Topics.topic)
                    .join(Topics, Topics.id == SoftwareTopics.topic_id)
                    .where(SoftwareTopics.software_id.in_(similar_ids))
                    .order_by(Topics.topic.asc())
                )
            ).all()
            for software_id, topic in similar_topic_rows:
                topics_by_software.setdefault(software_id, []).append(topic)

        similar_softwares = [
            SimilarSoftwareItem(
                full_name=row.full_name,
                name=row.name,
                html_url=row.html_url,
                abstract=row.abstract,
                description=row.description,
                language=row.language,
                source_updated_at=row.source_updated_at,
                repository=row.repository,
                citations=row.citations,
                license=row.license,
                created_at=row.created_at,
                updated_at=row.updated_at,
                topics=topics_by_software.get(row.id, []),
                similarity_score=max(0.0, 1.0 - float(row.distance or 0.0)),
            )
            for row in similar_rows
        ]

    return SoftwareDetailResult(
        software=SoftwareDetailItem(
            full_name=software.full_name,
            name=software.name,
            html_url=software.html_url,
            abstract=software.abstract,
            description=software.description,
            language=software.language,
            source_updated_at=software.source_updated_at,
            repository=software.repository,
            citations=software.citations,
            license=software.license,
            created_at=software.created_at,
            updated_at=software.updated_at,
            topics=software_topics,
        ),
        similar_softwares=similar_softwares,
    )
