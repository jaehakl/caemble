from __future__ import annotations

import asyncio
import json

import typer

from app import __version__
from app.control import run_slave_launcher
from app.settings import load_settings

app = typer.Typer(no_args_is_help=False)


@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        ctx.invoke(run)


@app.command()
def run() -> None:
    try:
        asyncio.run(run_slave_launcher(load_settings()))
    except KeyboardInterrupt:
        typer.echo("Stopped.")


@app.command("config-check")
def config_check() -> None:
    settings = load_settings()
    typer.echo(
        json.dumps(
            {
                "api_url": settings.api_url,
                "control_websocket_url": settings.control_websocket_url,
                "launcher_name": settings.launcher_name,
                "heartbeat_interval_seconds": settings.heartbeat_interval_seconds,
                "worker_ready_timeout_seconds": settings.worker_ready_timeout_seconds,
                "rtc_ice_servers_json": settings.rtc_ice_servers_json,
                "access_token": "set" if settings.access_token else "missing",
            },
            ensure_ascii=False,
            indent=2,
        )
    )


@app.command()
def version() -> None:
    typer.echo(__version__)
