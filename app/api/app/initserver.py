from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from gpstation.middleware import V1PublicCorsMiddleware
from gpstation.service.lifecycle import gpstation_lifespan
from settings import settings
from user_auth.routes import router as auth_router


def server() -> FastAPI:
    app = FastAPI(lifespan=gpstation_lifespan)
    app.include_router(auth_router)

    origins = sorted({settings.app_base_url, *settings.allowed_app_origins})
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(V1PublicCorsMiddleware)
    return app
