class GpStationError(RuntimeError):
    """Base error raised by the GP Station master SDK."""


class GpStationHttpError(GpStationError):
    """HTTP response error returned by the GP Station API."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"{status_code} {detail}")


class GpStationProtocolError(GpStationError):
    """Malformed or unexpected GP Station protocol data."""
