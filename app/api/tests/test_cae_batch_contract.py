import unittest
import uuid

from pydantic import ValidationError

from cae.models import BatchCreateRequest


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
