"""Application handlers registered by the API composition root."""

from typing import Any

# A handler module owns stage_record(db, job, packet, attachments) and
# complete_job(db, job, packet). The GPStation transport owns neither its input
# schema nor its persistence projection.
server_handlers: dict[str, Any] = {}
