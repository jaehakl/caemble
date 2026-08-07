from __future__ import annotations

from sdk.slave import SlaveApp, run_app

from app.handlers import register_handlers

app = SlaveApp(memory={"runs": {}})
register_handlers(app)


if __name__ == "__main__":
    run_app(app)
