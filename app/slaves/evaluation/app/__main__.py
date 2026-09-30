from __future__ import annotations

import json
import sys

from app.runtime import doctor


if __name__ == "__main__":
    if sys.argv[1:] == ["doctor"]:
        try:
            print(json.dumps(doctor(), ensure_ascii=False))
        except Exception as error:
            print(json.dumps({"ready": False, "error": str(error)}, ensure_ascii=False))
            raise SystemExit(1) from None
    else:
        from sdk.slave.server import ServerSlaveApp, run_server_app
        from app.worker import evaluate
        run_server_app(ServerSlaveApp(evaluate))
