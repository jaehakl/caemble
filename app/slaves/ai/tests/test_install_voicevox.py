from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import call, patch

from scripts import install_voicevox


class InstallVoicevoxTest(unittest.TestCase):
    def test_installer_uses_generic_ai_slave_user_agent(self) -> None:
        self.assertEqual(
            install_voicevox.VOICEVOX_INSTALLER_USER_AGENT,
            "gpstation-ai-voicevox-installer",
        )

    def test_resolve_output_dir_reads_only_voicevox_setting_from_dotenv(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(
                install_voicevox,
                "dotenv_values",
                return_value={"VOICEVOX_RUNTIME_DIR": "custom-runtime", "GH_TOKEN": "bad-token"},
            ),
        ):
            output_dir = install_voicevox.resolve_output_dir()
            self.assertNotIn("GH_TOKEN", os.environ)

        self.assertEqual(output_dir, install_voicevox.AI_DIR / "custom-runtime")

    def test_run_downloader_retries_without_invalid_github_credentials(self) -> None:
        command = [str(Path("download")), "--output", "runtime"]
        failure = subprocess.CalledProcessError(1, command)

        with (
            patch.dict(os.environ, {"GH_TOKEN": "bad-token", "GITHUB_TOKEN": "bad-token"}, clear=True),
            patch.object(install_voicevox.subprocess, "run", side_effect=[failure, None]) as run,
        ):
            install_voicevox.run_downloader(command)

        first_environment = run.call_args_list[0].kwargs["env"]
        retry_environment = run.call_args_list[1].kwargs["env"]
        self.assertEqual(first_environment["GH_TOKEN"], "bad-token")
        self.assertEqual(first_environment["GITHUB_TOKEN"], "bad-token")
        self.assertNotIn("GH_TOKEN", retry_environment)
        self.assertNotIn("GITHUB_TOKEN", retry_environment)
        self.assertEqual(
            run.call_args_list,
            [
                call(command, check=True, env=first_environment),
                call(command, check=True, env=retry_environment),
            ],
        )

    def test_run_downloader_does_not_hide_failure_without_credentials(self) -> None:
        command = [str(Path("download"))]
        failure = subprocess.CalledProcessError(1, command)

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(install_voicevox.subprocess, "run", side_effect=failure) as run,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            install_voicevox.run_downloader(command)

        run.assert_called_once_with(command, check=True, env={})


if __name__ == "__main__":
    unittest.main()
