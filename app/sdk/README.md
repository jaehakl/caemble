# Caemble GPStation v1 compatibility SDK

The bundled Python package contains the public GPStation v1 protocol messages and slave executable runtime used by Caemble.

```powershell
cd app/sdk
python -m pip install -e ".[slave]"
python -m pytest
```

The async Python master SDK is an independent package alongside the browser TypeScript SDK:

```powershell
cd app/sdk/master/python
poetry install
poetry run pytest
poetry build
```

```python
import asyncio
import os

from gpstation_master import GpStationClient


async def main() -> None:
    async with GpStationClient(
        api_base_url="http://127.0.0.1:8000",
        token=os.environ["CAEMBLE_CLIENT_TOKEN"],
    ) as client:
        result = await client.run_job(
            "ai.llm",
            {"system_prompt": "Answer concisely.", "prompt": "hello"},
        )
        print(result.payload)


asyncio.run(main())
```

See `master/python/README.md` for sessions, events, attachments, prewarm, and cookie authentication.
