"""Validate declared bounds against inline or stored tensor values."""
import asyncio
import hashlib
import json

from calculation_contract import assert_tensor_contract
from settings import settings
from storage.db import StorageObject
from storage.service import bucket_client, part_key, reference


async def validate_stored_tensor(db, contract: dict, tensor: dict, *, experiment_id: int) -> None:
    assert_tensor_contract(contract, tensor)
    data = tensor.get("data")
    if isinstance(data, dict) and ("min" in contract or "max" in contract):
        row = await db.get(StorageObject, data.get("id", ""))
        if (row is None or row.experiment_id != experiment_id or not row.ready
                or row.deleting or reference(row) != data or data.get("encoding") != "json"):
            raise ValueError("Stored tensor is unavailable in this Experiment.")

        def read_values():
            client = bucket_client()
            chunks = []
            for index, manifest in enumerate(row.manifest["chunks"]):
                response = client.get_object(Bucket=settings.s3_bucket, Key=part_key(row, index))
                body = response["Body"]
                try:
                    chunk = body.read()
                finally:
                    body.close()
                if len(chunk) != manifest["byteLength"] or hashlib.sha256(chunk).hexdigest() != manifest["sha256"]:
                    raise ValueError("Stored tensor checksum mismatch.")
                chunks.append(chunk)
            payload = b"".join(chunks)
            if hashlib.sha256(payload).hexdigest() != data["sha256"]:
                raise ValueError("Stored tensor checksum mismatch.")
            return json.loads(payload)

        tensor = {**tensor, "data": await asyncio.to_thread(read_values)}
    assert_tensor_contract(contract, tensor, values=True)
