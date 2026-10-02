from __future__ import annotations

import asyncio
from typing import Any

from sdk.slave import SlaveApp, SlaveContext

from app.handlers import register_handlers
from app.runtime import get_voicevox_runtime


def create_app() -> SlaveApp:
    app = SlaveApp(memory={})
    register_handlers(app)

    @app.initialize
    async def initialize(memory: Any, context: SlaveContext) -> None:
        await asyncio.to_thread(get_voicevox_runtime)

    return app
