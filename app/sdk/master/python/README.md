# Caemble GPStation v1 Master Python SDK

Async Python SDK for the master side of Caemble's GPStation v1-compatible job runtime.

## Install

```powershell
cd app/sdk/master/python
poetry install
```

The SDK requires Python 3.11 through 3.14. Client-scoped access tokens should be supplied at runtime, for example through an environment variable.

## Run one job

```python
import asyncio
import os

from gpstation_master import GpStationClient


async def main() -> None:
    async with GpStationClient(
        api_base_url="http://127.0.0.1:8000",
        token=os.environ["CAEMBLE_CLIENT_TOKEN"],
    ) as client:
        launchers = await client.list_launchers()
        print(launchers)

        result = await client.run_job(
            "ai.llm",
            {
                "system_prompt": "Answer concisely.",
                "prompt": "hello",
                "max_tokens": 128,
            },
            slave_app_id="ai",
        )
        print(result.payload)


asyncio.run(main())
```

## Keep a job session open

Set `auto_finish=False` to make more than one ordered call over the same WebRTC DataChannel. Finish the session explicitly before leaving the client context.

```python
first = await client.run_job(
    "ai.chat",
    {
        "system_prompt": "Answer concisely.",
        "prompt": "hello",
    },
    auto_finish=False,
)

followup = await first.session.call(
    "ai.chat",
    {"prompt": "Summarize the previous answer."},
)

await first.session.finish()
print(first.payload, followup.payload)
```

## Events and attachments

Callbacks are synchronous and run in DataChannel arrival order. Delegate slow work with `asyncio.create_task` so it does not delay result handling.

```python
from pathlib import Path

from gpstation_master import JobEvent, RequestAttachment


def on_event(event: JobEvent) -> None:
    if event.type == "ai.chat.delta":
        print(event.payload)


result = await client.run_job(
    "ai.sdxl.inpaint",
    {
        "prompts": ["a renovated room with warm lighting"],
        "strength": 0.8,
        "width": 1024,
        "height": 1024,
    },
    on_event=on_event,
    attachments=[
        RequestAttachment(
            id="image",
            name="input.png",
            mime_type="image/png",
            data=Path("input.png").read_bytes(),
        ),
        RequestAttachment(
            id="mask",
            name="mask.png",
            mime_type="image/png",
            data=Path("mask.png").read_bytes(),
        ),
    ],
)

for received_file in result.files:
    Path(received_file.name or received_file.id).write_bytes(received_file.data)
```

Each request attachment is limited to 20 MiB. Files are transferred directly over the job DataChannel and are not uploaded through the REST API.

## Prewarm and cookie authentication

`await client.prewarm_job_connection()` gathers an offer and ICE candidates ahead of the next matching job. Successful auto-finished jobs refill the cache in the background.

Cookie authentication is intended for an existing website session. Supply its cookies and use the web job prefix; unsafe `/web/` requests automatically fetch and refresh a CSRF token.

```python
async with GpStationClient(
    api_base_url="http://127.0.0.1:8000",
    auth_mode="cookie",
    job_api_prefix="/web/jobs",
    cookies={"<session-cookie-name>": "..."},
) as client:
    result = await client.run_job(
        "ai.llm",
        {"system_prompt": "Answer concisely.", "prompt": "hello"},
    )
```

## Verify

```powershell
poetry run pytest
poetry build
```

## Opt-in live contract smoke

`tests/test_live_e2e.py` exercises the published 0.1.0 bearer API without a
GPStation checkout or private client hooks. It constructs `GpStationClient`
with only the Caemble API base URL and a client-scoped token, verifies that one
connected launcher advertises both `ai` and `cae`, then runs
`cae.solvers.manifests`, `ai.llm.models`, and a streaming `ai.chat` session
that is explicitly finished.

The normal test suite reports this test as skipped when either required
credential is absent. To run it against a live Caemble deployment:

```powershell
$env:CAEMBLE_V1_E2E_API_BASE_URL = "https://www.caemble.com/api"
$env:CAEMBLE_V1_E2E_CLIENT_TOKEN = "<client-scoped-token>"
$env:CAEMBLE_V1_E2E_TIMEOUT_SECONDS = "300" # optional
poetry run pytest -rs tests/test_live_e2e.py
```

The timeout must be a positive number and applies to each WebRTC job call and
explicit session finish.
