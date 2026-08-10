from pathlib import Path

from gpstation.models import JobCreateRequest
from sdk.protocol.messages import SignalPayload


def test_bundled_python_and_js_master_sdks_share_the_v1_request_contract():
    sdk_root = Path(__file__).resolve().parents[2] / "sdk" / "master"
    python_client = (
        sdk_root / "python" / "gpstation_master" / "client.py"
    ).read_text(encoding="utf-8")
    javascript_client = (sdk_root / "js" / "src" / "client.ts").read_text(
        encoding="utf-8"
    )

    assert 'job_api_prefix: str = "/v1/jobs"' in python_client
    assert 'self._request("/v1/launchers")' in python_client
    assert 'f"{self._job_api_prefix}/{quote(job_id, safe=\'\')}/kill"' in python_client
    assert "/wait-answer" in python_client
    assert "options.jobApiPrefix ?? '/v1/jobs'" in javascript_client
    assert "this.request<LauncherView[]>('/v1/launchers')" in javascript_client
    assert "/kill" in javascript_client
    assert "/wait-answer" in javascript_client
    for field_name in ("handler_type", "slave_app_id", "offer"):
        assert f'"{field_name}"' in python_client
        assert f"{field_name}:" in javascript_client

    request_shape = {
        "handler_type": "cae.simulation.start",
        "slave_app_id": "cae",
        "offer": {"type": "offer", "sdp": "v=0"},
    }
    parsed = JobCreateRequest.model_validate(request_shape)
    signal = SignalPayload.model_validate(parsed.offer)
    assert parsed.model_dump() == request_shape
    assert signal.type == "offer"
