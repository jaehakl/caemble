from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import (
    Base,
    SessionLocal,
    engine,
)
from api.models import (
    MergeTopicsRequest,
    MergeTopicsResult,
    SoftwareDeleteResult,
    SoftwareDetailResult,
    SoftwareFilterOptionsResult,
    SoftwareSearchRequest,
    SoftwareSearchResult,
    SoftwareUpsertItem,
    SwUpsertBatchResult,
    TopicDeleteResult,
    TopicRead,
)
from api.admin_service.sw_admin_service import sw_delete_service, sw_upsert_batch_service
from api.admin_service.topic_admin_service import (
    delete_topic_service,
    merge_topics_service,
)
from api.service.sw_service import (
    sw_detail_service,
    sw_filter_options_service,
    sw_search_service,
)
from api.service.topic_service import list_topics_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        try:
            await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS citext;")
            await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
            await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector;")
        except Exception:
            pass
        await conn.run_sync(Base.metadata.create_all)
    yield


app = FastAPI(lifespan=lifespan)

# CORS settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session


# Admin mutation APIs (create/update/delete)
@app.post("/api/sw_upsert_batch", response_model=SwUpsertBatchResult)
async def sw_upsert_batch(
    payload: list[SoftwareUpsertItem], db: AsyncSession = Depends(get_db)
) -> SwUpsertBatchResult:
    return await sw_upsert_batch_service(db, payload)


# Read APIs
@app.post("/api/sw_search", response_model=SoftwareSearchResult)
async def sw_search(
    payload: SoftwareSearchRequest, db: AsyncSession = Depends(get_db)
) -> SoftwareSearchResult:
    return await sw_search_service(db, payload)


@app.get("/api/sw_filter_options", response_model=SoftwareFilterOptionsResult)
async def sw_filter_options(db: AsyncSession = Depends(get_db)) -> SoftwareFilterOptionsResult:
    return await sw_filter_options_service(db)


@app.get("/api/sw_detail/{full_name:path}", response_model=SoftwareDetailResult)
async def sw_detail(full_name: str, db: AsyncSession = Depends(get_db)) -> SoftwareDetailResult:
    return await sw_detail_service(db, full_name)


# Admin mutation APIs (create/update/delete)
@app.delete("/api/sw_delete/{full_name:path}", response_model=SoftwareDeleteResult)
async def sw_delete(full_name: str, db: AsyncSession = Depends(get_db)) -> SoftwareDeleteResult:
    return await sw_delete_service(db, full_name)


@app.get("/api/topics", response_model=list[TopicRead])
async def get_topics(db: AsyncSession = Depends(get_db)) -> list[TopicRead]:
    return await list_topics_service(db)


@app.post("/api/merge_topics", response_model=MergeTopicsResult)
async def merge_topics(
    payload: MergeTopicsRequest, db: AsyncSession = Depends(get_db)
) -> MergeTopicsResult:
    return await merge_topics_service(db, payload)


@app.delete("/api/topics/{topic_id}", response_model=TopicDeleteResult)
async def delete_topic(topic_id: int, db: AsyncSession = Depends(get_db)) -> TopicDeleteResult:
    return await delete_topic_service(db, topic_id)


'''
@app.get("/api/hello")
def read_root():
    return {"message": "hello"}


@app.get("/api/notes", response_model=list[NoteRead])
async def read_notes(db: AsyncSession = Depends(get_db)):
    return await list_notes(db)


@app.get("/api/notes/{note_id}", response_model=NoteRead)
async def read_note(note_id: int, db: AsyncSession = Depends(get_db)):
    note = await get_note(db, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@app.post("/api/notes", response_model=NoteRead)
async def create_note_route(payload: NoteCreate, db: AsyncSession = Depends(get_db)):
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="title is required")
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="content is required")
    return await create_note(db, payload)


@app.put("/api/notes/{note_id}", response_model=NoteRead)
async def update_note_route(note_id: int, payload: NoteUpdate, db: AsyncSession = Depends(get_db)):
    note = await get_note(db, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="title is required")
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="content is required")
    return await update_note(db, note, payload)


@app.delete("/api/notes/{note_id}")
async def delete_note_route(note_id: int, db: AsyncSession = Depends(get_db)):
    note = await get_note(db, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    await delete_note(db, note)
    return {"ok": True}
'''
