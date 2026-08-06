from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from settings import settings
from user_auth.routes import router as auth_router


def server():
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.progress = 0
        print("service is started.")
        yield
        print("service is stopped.")

    app = FastAPI(lifespan=lifespan)
    app.include_router(auth_router)

    origins = sorted({settings.app_base_url, *settings.allowed_app_origins})

    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_origins=origins,
        # allow_origin_regex="https://.*\.onigiri\.kr",
        allow_methods=["GET", "POST", "OPTIONS", "PUT", "DELETE"],
        allow_headers=["*"],
    )

    return app
