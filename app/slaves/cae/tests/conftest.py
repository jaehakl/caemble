"""Test-only input sharing; ordinary pytest retains its complete test collection."""

from pathlib import Path
import os

import pytest

@pytest.fixture(scope="session")
def catalog_builds(tmp_path_factory, request):
    from tests.catalog_build import CatalogBuilds

    configured = os.environ.get("CAEMBLE_TEST_RUN_DIR")
    if configured:
        shared = Path(configured) / "builds"
    else:
        base = tmp_path_factory.getbasetemp()
        shared = (base.parent if hasattr(request.config, "workerinput") else base) / "catalog-builds"
    return CatalogBuilds(shared, Path(__file__).resolve().parents[4])
