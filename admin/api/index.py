from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import (
    Base,
    SessionLocal,
    engine,
)
from api.models import SoftwareUpsertItem, SwUpsertBatchResult
from api.service.sw_service import sw_upsert_batch_service


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


@app.post("/api/sw_upsert_batch", response_model=SwUpsertBatchResult)
async def sw_upsert_batch(
    payload: list[SoftwareUpsertItem], db: AsyncSession = Depends(get_db)
) -> SwUpsertBatchResult:
    return await sw_upsert_batch_service(db, payload)


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
