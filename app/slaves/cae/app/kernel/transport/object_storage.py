"""Direct object transfer for CAE jobs; no bucket credentials enter the worker."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen

INLINE_BYTES = 64 * 1024
CHUNK_BYTES = 8 * 1024 * 1024


async def storage_request(context, operation, **body):
    await context.send({"type": f"job.storage.{operation}", **body})
    reply, attachments = await asyncio.wait_for(context.receive(), timeout=120)
    if reply.get("type") != f"job.storage.{operation}.ack" or attachments:
        raise ValueError("Unexpected object storage acknowledgement.")
    return reply


def transfer_part(part, data=None):
    request = Request(part["url"], data=data, method="GET" if data is None else "PUT",
                      headers=part.get("headers", {}))
    try:
        with urlopen(request, timeout=60) as response:
            if data is None:
                raw = response.read(part["byteLength"] + 1)
                if len(raw) != part["byteLength"] or hashlib.sha256(raw).hexdigest() != part["sha256"]:
                    raise ValueError("Stored object chunk checksum differs from its manifest.")
                return raw
    except HTTPError as error:
        if data is not None and error.code == 412:
            return None  # The API verifies the previous upload's bytes at commit.
        raise RuntimeError(f"S3 transfer failed ({error.code}).") from None


async def read_object(context, ref):
    ticket = await storage_request(context, "read", reference=ref)
    raw = bytearray()
    for index in range(len(ticket["parts"])):
        for attempt in range(3):
            try:
                data = await asyncio.to_thread(transfer_part, ticket["parts"][index])
                raw.extend(data)
                break
            except (RuntimeError, OSError):
                if attempt == 2:
                    raise
                ticket = await storage_request(context, "read", reference=ref)
    if len(raw) != ref["byteLength"] or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
        raise ValueError("Stored input hash differs from its manifest.")
    return json.loads(raw.decode("utf-8"))


async def resolve_input(context, value):
    if isinstance(value, dict):
        if value.get("kind") == "caemble.object":
            return await read_object(context, value)
        return {key: await resolve_input(context, member) for key, member in value.items()}
    if isinstance(value, list):
        return [await resolve_input(context, member) for member in value]
    return value


async def upload_object(context, raw, encoding, length=None):
    manifest = {"encoding": encoding, "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "chunks": [{"byteLength": len(raw[offset:offset + CHUNK_BYTES]),
                            "sha256": hashlib.sha256(raw[offset:offset + CHUNK_BYTES]).hexdigest()}
                           for offset in range(0, len(raw), CHUNK_BYTES)]}
    if length is not None:
        manifest["length"] = length
    ticket = await storage_request(context, "prepare", manifest=manifest)
    if not ticket.get("ready"):
        for index in range(len(ticket["parts"])):
            for attempt in range(3):
                try:
                    await asyncio.to_thread(transfer_part, ticket["parts"][index], raw[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES])
                    break
                except (RuntimeError, OSError):
                    if attempt == 2:
                        raise
                    ticket = await storage_request(context, "prepare", manifest=manifest)
                    if ticket.get("ready"):
                        break
    reply = await storage_request(context, "complete", object_id=ticket["reference"]["id"])
    return reply["reference"]


async def externalize_record(context, value, attachments):
    if isinstance(value, str) or (isinstance(value, list) and all(not isinstance(item, dict) for item in value)):
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        if len(raw) > INLINE_BYTES:
            return await upload_object(context, raw, "json", len(value) if isinstance(value, list) else None)
    if isinstance(value, list):
        return [await externalize_record(context, member, attachments) for member in value]
    if isinstance(value, dict):
        if value.get("kind") == "attachments":
            raw = b"".join(attachments[key] for key in value["ids"])
            if len(raw) != value["byteLength"]:
                raise ValueError("Record attachment byte length mismatch.")
            data = await upload_object(context, raw, "base64") if len(raw) > INLINE_BYTES else base64.b64encode(raw).decode("ascii")
            return {"kind": "base64", "data": data, "byteLength": len(raw)}
        return {key: await externalize_record(context, member, attachments) for key, member in value.items()}
    return value
