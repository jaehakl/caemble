import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import install_voicevox as installer


class InstallerTests(unittest.TestCase):
    def test_default_cuda_and_explicit_cpu_pin_runtime_and_include_dependencies(self):
        binary = b"fixture downloader"
        digest = hashlib.sha256(binary).hexdigest()
        for arguments, expected in (([], "cuda"), (["--device", "cpu"], "cpu")):
            with self.subTest(device=expected), tempfile.TemporaryDirectory() as directory, \
                 patch("sys.argv", ["install_voicevox.py", *arguments]), \
                 patch.object(installer.platform, "system", return_value="Windows"), \
                 patch.object(installer.platform, "machine", return_value="AMD64"), \
                 patch.object(installer, "DOWNLOADERS", {("Windows", "x86_64"): ("download.exe", digest)}), \
                 patch.object(installer, "resolve_output_dir", return_value=Path(directory)), \
                 patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(binary)), \
                 patch.object(installer, "install_windows_zlib") as zlib, \
                 patch.object(installer, "run_downloader") as run:
                self.assertEqual(installer.main(), 0)
                command = run.call_args.args[0]
                self.assertEqual(command[command.index("--devices") + 1], expected)
                self.assertEqual(command[command.index("--c-api-version") + 1], "0.16.4")
                self.assertEqual(command[command.index("--onnxruntime-version") + 1], "voicevox_onnxruntime-1.17.3")
                self.assertEqual(command[command.index("--additional-libraries-version") + 1], "0.2.1")
                self.assertEqual(command[command.index("--models-version") + 1], "0.16.4")
                self.assertIn("additional-libraries", command)
                self.assertEqual(zlib.call_count, int(expected == "cuda"))

    def test_zlib_archive_checksum_failure_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")):
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                installer.install_windows_zlib(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
