from __future__ import annotations

from typing import Any

from sdk.slave import SlaveApp, SlaveContext, run_app

from app.embeddings import initialize as initialize_embeddings
from app.embeddings import register_handlers as register_embeddings_handlers
from app.llm import initialize as initialize_llm
from app.llm import register_handlers as register_llm_handlers
from app.logging import log_exception
from app.sdxl import initialize as initialize_sdxl
from app.sdxl import register_handlers as register_sdxl_handlers
from app.vision import initialize as initialize_vision
from app.vision import register_handlers as register_vision_handlers
from app.voicevox import register_handlers as register_voicevox_handlers


app = SlaveApp(memory={})
register_llm_handlers(app)
register_embeddings_handlers(app)
register_vision_handlers(app)
register_sdxl_handlers(app)
register_voicevox_handlers(app)


@app.initialize
async def initialize(memory: dict[str, Any] | None, context: SlaveContext) -> None:
    try:
        await initialize_embeddings(context)
        await initialize_vision(context)
        await initialize_llm(context)
        await initialize_sdxl(context)
    except Exception as exc:
        log_exception(f"ai initialize import warmup failed session={context.session_id}", exc)
        raise


if __name__ == "__main__":
    run_app(app)
