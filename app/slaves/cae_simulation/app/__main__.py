from __future__ import annotations

from sdk.slave.server import ServerSlaveApp, run_server_app

from app.kernel.transport.handlers import run_measurement

app = ServerSlaveApp(run_measurement)


if __name__ == "__main__":
    run_server_app(app)
