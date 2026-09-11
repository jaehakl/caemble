import hashlib
import json
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from pydantic import ValidationError

from cae.batches import create_batch
from cae.models import BatchCreateRequest
from models import RoleEnum, UserData


class BatchCandidateContractTests(unittest.TestCase):
    def test_multiple_candidates_and_single_candidate_remain_valid(self):
        for count in (1, 3):
            request = BatchCreateRequest(
                request_id=uuid.uuid4(), experiment_id=1,
                experiment_source_hash="a" * 64, mode="candidate",
                catalog_revision="catalog", builder_version="2",
                items=[{"index": i, "input_hash": "b" * 64, "byte_length": 10}
                       for i in range(1, count + 1)],
            )
            self.assertEqual(len(request.items), count)
            with self.assertRaises(ValidationError):
                BatchCreateRequest.model_validate({**request.model_dump(), "mode": "measurement"})
            if count == 1:
                measurement = {**request.model_dump(), "mode": "measurement"}
                measurement["items"][0]["measurement_id"] = 7
                self.assertEqual(BatchCreateRequest.model_validate(measurement).items[0].measurement_id, 7)
            else:
                measurement = {**request.model_dump(), "mode": "measurement"}
                for index, item in enumerate(measurement["items"], 1):
                    item["measurement_id"] = index
                with self.assertRaises(ValidationError):
                    BatchCreateRequest.model_validate(measurement)


class BatchCreationRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_batch_modes_do_not_require_retired_execution_mode(self):
        for mode in ("candidate", "generate"):
            with self.subTest(mode=mode):
                request = BatchCreateRequest(
                    request_id=uuid.uuid4(), experiment_id=1,
                    experiment_source_hash="a" * 64, mode=mode,
                    catalog_revision="catalog", builder_version="2",
                    items=[{"index": 1, "input_hash": "b" * 64, "byte_length": 10}],
                )
                experiment = SimpleNamespace(source_hash="a" * 64, user_id="owner")
                db = SimpleNamespace(
                    scalar=AsyncMock(side_effect=[None, experiment]), add=Mock(),
                    flush=AsyncMock(), commit=AsyncMock(),
                )
                catalog = SimpleNamespace(meta=lambda: {"catalogRevision": "catalog"})
                user = UserData(id="owner", roles=[RoleEnum.user])

                with patch("cae.batches.serialize_events", AsyncMock()), patch(
                    "cae.batches.add_event", AsyncMock()
                ):
                    batch = await create_batch(db, request, user, catalog)

                request_data = request.model_dump(mode="json")
                request_data.pop("preflight")
                request_data.pop("source_bundle")
                expected_hash = hashlib.sha256(json.dumps(
                    request_data, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                ).encode()).hexdigest()
                self.assertEqual(batch.request_hash, expected_hash)
                self.assertEqual(db.add.call_count, 3)
                db.commit.assert_awaited_once()
