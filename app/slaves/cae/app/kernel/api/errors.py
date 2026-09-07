from __future__ import annotations


class CaeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ProtocolError(ValueError):
    """A malformed start/next exchange that must fail the Caemble v1 transport."""
