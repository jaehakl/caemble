"""External keys and uploaded input contracts are independent of internal Agent code."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from cae.models import BatchCreateRequest
from cae.recording import persist_record
from cae.uploads import validate_artifact_item
from gpstation.service.auth_service import Principal
from models import RoleEnum, UserData
from service.client_auth import authenticate_caemble
from service.data_tools import VisibleDataError, slice_recorded_tensor


class ClientContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_account_key_is_owner_scoped_and_cannot_manage_keys(self):
        db = AsyncMock()
        principal = Principal("key", "owner", frozenset({"caemble"}))
        user = UserData(id="owner", roles=[RoleEnum.admin])
        with patch("service.client_auth.authenticate_db_authorization", AsyncMock(return_value=principal)), patch(
            "service.client_auth.user_data", return_value=user
        ):
            permitted = Request({"type": "http", "path": "/experiment/save", "headers": []})
            actual = await authenticate_caemble(permitted, db, "Bearer csk_test")
            self.assertEqual(actual.roles, [RoleEnum.user])
            for path in ("/web/users/me/access-tokens", "/web/crud/access_keys/delete", "/users/list", "/auth/refresh"):
                with self.subTest(path=path), self.assertRaises(HTTPException) as failure:
                    await authenticate_caemble(Request({"type": "http", "path": path, "headers": []}), db, "Bearer csk_test")
                self.assertEqual(failure.exception.status_code, 403)

    async def test_client_and_launcher_keys_do_not_gain_authoring_scope(self):
        for scope in ("client", "launcher"):
            with self.subTest(scope=scope), patch(
                "service.client_auth.authenticate_db_authorization",
                AsyncMock(return_value=Principal("key", "owner", frozenset({scope}))),
            ), self.assertRaises(HTTPException) as failure:
                await authenticate_caemble(Request({"type": "http", "path": "/cae/batches", "headers": []}), AsyncMock(), "Bearer csk_test")
            self.assertEqual(failure.exception.status_code, 403)

    def test_legacy_prepare_request_explains_update_requirement(self):
        with self.assertRaisesRegex(ValidationError, "Server prepare was removed"):
            BatchCreateRequest.model_validate({"mode": "generate", "count": 20})

    def test_forged_source_hash_is_rejected_before_worker_assignment(self):
        with self.assertRaises(HTTPException) as failure:
            validate_artifact_item({"measurement": {"kind": "measurement", "experiment": {"sourceHash": "wrong"}}}, "expected")
        self.assertEqual(failure.exception.status_code, 409)

    def test_tensor_slice_is_bounded_and_has_a_stable_end(self):
        tensor = {"shape": [2], "storage": {"kind": "inline", "value": [1, 2]}}
        self.assertEqual(slice_recorded_tensor(tensor, "float64", 2, 10)["values"], [])
        for offset, count in ((-1, 5), (3, 5), (0, 10001)):
            with self.assertRaises(VisibleDataError):
                slice_recorded_tensor(tensor, "float64", offset, count)

    def test_persisted_large_string_tensor_slice_preserves_unicode_and_shape(self):
        values = [[f"한글 결과 {index}-{column}" for column in range(2)] for index in range(2000)]
        raw = json.dumps(values, ensure_ascii=False).encode("utf-8")
        self.assertGreater(len(raw), 64 * 1024)
        persisted = persist_record(
            {"dtype": "string"},
            {
                "shape": [2000, 2],
                "storage": {"kind": "attachments", "ids": ["first", "second"], "byteLength": len(raw)},
            },
            {"first": raw[:17], "second": raw[17:]},
        )
        self.assertEqual(persisted["storage"]["kind"], "base64")
        self.assertEqual(
            slice_recorded_tensor(persisted, "string", 3997, 10),
            {
                "shape": [2000, 2],
                "totalValues": 4000,
                "offset": 3997,
                "values": [values[1998][1], *values[1999]],
                "nextOffset": None,
            },
        )
        self.assertEqual(slice_recorded_tensor(persisted, "string", 1, 2)["nextOffset"], 3)
        self.assertEqual(slice_recorded_tensor(persisted, "string", 4000, 10)["values"], [])


if __name__ == "__main__":
    unittest.main()
