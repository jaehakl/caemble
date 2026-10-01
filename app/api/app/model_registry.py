"""Register the application's complete ORM graph at composition boundaries."""

from importlib import import_module


def register_models() -> None:
    for module in (
        "user_auth.db", "gpstation.db", "simulation.db",
        "optimization.db", "calculation.db", "storage.db", "prediction.db",
    ):
        import_module(module)
