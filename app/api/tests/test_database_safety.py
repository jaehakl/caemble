"""Disposable integration databases must never use a configured remote server."""
import unittest
from unittest.mock import AsyncMock, patch

import test_calculation_database as database_helpers


class DatabaseSafetyTests(unittest.IsolatedAsyncioTestCase):
    def test_explicit_loopback_urls_keep_the_selected_test_server(self):
        for host in ("localhost", "127.0.0.1", "[::1]"):
            with self.subTest(host=host), patch.object(database_helpers, "ORIGINAL_DB_URL", f"postgresql+asyncpg://test:test@{host}:55439/postgres"):
                arguments = database_helpers._connect_arguments("caemble_calculation_test_1234")
                self.assertEqual(arguments["host"], host.strip("[]"))
                self.assertEqual(arguments["port"], 55439)
                self.assertEqual(arguments["database"], "caemble_calculation_test_1234")
                self.assertTrue(database_helpers._database_url("caemble_calculation_test_1234").endswith("/caemble_calculation_test_1234"))

    async def test_remote_urls_are_rejected_before_any_connection(self):
        for host in ("database.example.invalid", "192.0.2.10"):
            with self.subTest(host=host), patch.object(database_helpers, "ORIGINAL_DB_URL", f"postgresql+asyncpg://test:test@{host}/postgres"), patch.object(database_helpers.asyncpg, "connect", AsyncMock()) as connect:
                for operation in (database_helpers._database_url, database_helpers._connect_arguments):
                    with self.assertRaisesRegex(RuntimeError, "loopback DB_URL"):
                        operation("caemble_calculation_test_1234")
                with self.assertRaisesRegex(RuntimeError, "loopback DB_URL"):
                    await database_helpers._create_database("caemble_calculation_test_1234")
                with self.assertRaisesRegex(RuntimeError, "loopback DB_URL"):
                    await database_helpers._drop_database("caemble_calculation_test_1234")
                connect.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
