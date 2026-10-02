import unittest
from unittest.mock import AsyncMock

from gpstation_master.client import GpStationClient, _parse_job_create_result, _parse_job_answer_wait_result
from gpstation_master.errors import GpStationProtocolError


class JobResponseTests(unittest.TestCase):
    def test_assigned_creation_response_keeps_job_id_without_requiring_wait_identity(self):
        result = _parse_job_create_result({
            "job": {
                "id": "job", "user_id": "user", "handler_type": "ai.llm", "slave_app_id": "ai",
                "offer": {"type": "offer", "sdp": "offer-sdp"}, "state": "assigned",
                "launcher_id": "launcher", "attempt_id": "attempt", "instance_id": "instance",
                "attempt_count": 1, "resources": {}, "allocation": None,
            },
            "answer_wait_url": "/v1/jobs/job/wait-answer",
        })
        self.assertEqual(result.job.id, "job")
        self.assertEqual(result.job.launcher_id, "launcher")
        self.assertEqual(result.job.attempt_count, 1)
        self.assertIsNone(result.job.execution)

    def test_wait_answer_binds_complete_execution_identity(self):
        value = {
            "job_id": "job", "state": "answer_ready", "launcher_id": "launcher", "boot_id": "boot",
            "instance_id": "instance", "attempt_id": "attempt", "attempt_count": 1,
            "reservation_id": "reservation", "answer": {"type": "answer", "sdp": "answer-sdp"},
        }
        result = _parse_job_answer_wait_result(value)
        self.assertEqual(result.execution.job_id, "job")
        self.assertEqual(result.execution.reservation_id, "reservation")
        del value["boot_id"]
        with self.assertRaisesRegex(GpStationProtocolError, "Incomplete execution identity"):
            _parse_job_answer_wait_result(value)

    def test_queued_wait_response_has_no_execution_identity(self):
        result = _parse_job_answer_wait_result({
            "job_id": "job", "state": "queued", "attempt_id": "attempt", "attempt_count": 1,
            "launcher_id": None, "boot_id": None, "instance_id": None, "reservation_id": None,
        })
        self.assertIsNone(result.execution)

    def test_cancelled_unassigned_attempt_keeps_original_error(self):
        result = _parse_job_answer_wait_result({
            "job_id": "job", "state": "cancelled", "attempt_id": "attempt", "attempt_count": 1,
            "last_error": "Cancelled while queued",
        })
        self.assertIsNone(result.execution)
        self.assertEqual(result.last_error, "Cancelled while queued")


class JobAnswerPollingTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_attempt_continues_until_complete_worker_answer(self):
        client = GpStationClient("https://example.invalid", token="test")
        client._request = AsyncMock(side_effect=[
            {"job_id": "job", "state": "queued", "attempt_id": "attempt", "attempt_count": 1},
            {
                "job_id": "job", "state": "answer_ready", "attempt_id": "attempt", "attempt_count": 1,
                "launcher_id": "launcher", "boot_id": "boot", "instance_id": "instance",
                "reservation_id": "reservation", "answer": {"type": "answer", "sdp": "answer-sdp"},
            },
        ])
        try:
            result = await client._wait_job_answer("job", timeout_seconds=5)
            self.assertEqual(client._request.await_count, 2)
            self.assertEqual(result.execution.reservation_id, "reservation")
        finally:
            await client.close()
