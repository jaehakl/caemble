from __future__ import annotations

import asyncio

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


@app.command()
def version() -> None:
    typer.echo(__version__)
