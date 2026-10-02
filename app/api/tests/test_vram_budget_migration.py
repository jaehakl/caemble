import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa


def test_request_migration_preserves_allocations_and_handles_zero(monkeypatch):
    path = Path(__file__).resolve().parents[1] / "alembic/versions/000000000027_vram_budgets.py"
    spec = importlib.util.spec_from_file_location("vram_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    tables = [sa.Table(name, metadata, sa.Column(key, sa.String, primary_key=True),
                      sa.Column("resources", sa.JSON), sa.Column("allocation", sa.JSON),
                      sa.Column("handler_type", sa.String), sa.Column("input", sa.JSON))
              for name, key in (("jobs", "id"), ("execution_attempts", "id"), ("prediction_training_runs", "operation_id"))]
    metadata.create_all(engine)
    historical = {"gpu_memory_bytes": 12 * 1024**3, "gpu_devices": ["GPU-old"]}
    with engine.begin() as connection:
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)
        for table in tables:
            key = list(table.primary_key)[0].name
            connection.execute(table.insert(), [
                {key: "budget", "resources": {"gpu_memory_bytes": 12 * 1024**3, "cpu_cores": 2}, "allocation": historical},
                {key: "zero", "resources": {"gpu_memory_bytes": 0, "gpu_count": 0}, "allocation": None}])
        connection.execute(tables[0].update().where(tables[0].c.id == "budget").values(
            handler_type="cae.evaluation.predict", input={"hybrid": {"resources": {
                "predictor": {"gpu_count": 1, "gpu_memory_bytes": 6*1024**3}, "evaluation": {"gpu_count": 0, "gpu_memory_bytes": 0}}}}))
        migration.upgrade()
        migration.upgrade()  # Resumable conversion.
        for table in tables:
            rows = connection.execute(sa.select(table).order_by(list(table.primary_key)[0])).mappings().all()
            assert rows[0]["resources"] == {"vram_budget_gb": 12, "cpu_cores": 2}
            assert rows[0]["allocation"] == historical
            assert rows[1]["resources"] == {"gpu_count": 0}
        assert connection.execute(sa.select(tables[0].c.input).where(tables[0].c.id == "budget")).scalar_one()["hybrid"]["resources"] == {
            "predictor": {"gpu_count": 1, "vram_budget_gb": 6}, "evaluation": {"gpu_count": 0}}
        migration.downgrade()
        assert connection.execute(sa.select(tables[0].c.resources).where(tables[0].c.id == "budget")).scalar_one() == {"gpu_memory_bytes": 12 * 1024**3, "cpu_cores": 2}
    with pytest.raises(ValueError, match="Conflicting"):
        migration.convert_resources({"gpu_memory_bytes": 1, "vram_budget_gb": 1})
