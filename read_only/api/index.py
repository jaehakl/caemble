from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import (
    Base,
    SessionLocal,
    engine,
)
from api.models import (
    SoftwareDetailResult,
    SoftwareFilterOptionsResult,
    SoftwareSearchRequest,
    SoftwareSearchResult,
)
from api.service.sw_service import (
    sw_detail_service,
    sw_filter_options_service,
    sw_search_service,
)

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


app = FastAPI( lifespan=lifespan)

# CORS settings
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[
        "http://localhost",
        "http://localhost:5173",
        "http://localhost:3000",
    ],
    allow_origin_regex=r"https://.*\.(caemble\.com|vercel\.app)",
    allow_methods=["GET","POST","OPTIONS"],
    allow_headers=["*"],
)


async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session


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
