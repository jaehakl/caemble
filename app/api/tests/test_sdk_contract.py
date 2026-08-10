import pytest
from pydantic import ValidationError

from gpstation.service import job_service, launcher_connection
from sdk.protocol import messages


def test_api_uses_the_bundled_sdk_as_its_strict_protocol_contract():
    assert launcher_connection.LauncherHello is messages.LauncherHello
    assert launcher_connection.parse_launcher_message is messages.parse_launcher_message
    assert job_service.SignalPayload is messages.SignalPayload

    hello = messages.parse_launcher_message(
        {
            "type": "launcher.hello",
            "launcher_name": "local-launcher",
            "slave_app_ids": ["ai", "cae"],
            "metadata": {"한글": "정상"},
        }
    )
    assert isinstance(hello, messages.LauncherHello)

    job_start = messages.parse_server_message(
        {
            "type": "job.start",
            "job_id": "job-1",
            "handler_type": "cae.simulation.start",
            "slave_app_id": "cae",
            "offer": {"type": "offer", "sdp": "v=0"},
        }
    )
    assert isinstance(job_start, messages.JobStart)
    with pytest.raises(ValidationError):
        messages.parse_launcher_message(
            {
                "type": "launcher.hello",
                "launcher_name": "local-launcher",
                "slave_app_ids": ["cae"],
                "metadata": {},
                "unexpected": True,
            }
        )
