"""Crash-safe launcher identity, active-container inventory and cleanup receipts."""
from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4


class LauncherJournal:
    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "runtime.json"
        self.lock_file = (directory / "runtime.lock").open("a+b")
        self.lock_file.seek(0)
        if os.name == "nt":
            import msvcrt
            if self.lock_file.read(1) == b"":
                self.lock_file.write(b"0")
                self.lock_file.flush()
            self.lock_file.seek(0)
            msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {
            "installation_id": str(uuid4()), "instances": {}, "cleanup_receipts": {}}
        self.save()

    def save(self) -> None:
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(self.data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def close(self) -> None:
        self.lock_file.close()
