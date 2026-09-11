from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402, F401
import gpstation.db  # noqa: E402, F401
import user_auth.db  # noqa: E402, F401
from models import RecordedDataListRequest  # noqa: E402
from service.recorded_data import list_recorded_data  # noqa: E402


class RecordedDataServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_result_names_are_not_filtered(self) -> None:
        with patch(
            "service.recorded_data.get_list_response",
            new=AsyncMock(return_value={"total": 0, "items": []}),
        ) as get_list:
            await list_recorded_data(
                object(),  # type: ignore[arg-type]
                RecordedDataListRequest(),
                user=None,
            )
            clause = get_list.await_args.args[3]
            self.assertIsNone(clause)

            await list_recorded_data(
                object(),  # type: ignore[arg-type]
                RecordedDataListRequest(),
                user=None,
            )
            self.assertIsNone(get_list.await_args.args[3])


if __name__ == "__main__":
    unittest.main()
