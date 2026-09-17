"""Isolated runtime import and Catalog registration probes; no solver execution."""

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path


def test_solver_api_import_does_not_load_runtime_implementations() -> None:
    script = (
        "import json, sys; from app.kernel.api import *; "
        "print(json.dumps(sorted(name for name in sys.modules "
        "if name.startswith(('app.kernel.resources', "
        "'app.kernel.execution', 'app.kernel.coordinator', "
        "'app.kernel.transport', 'app.methods', 'app.solvers', "
        "'app.solver_framework')))))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(completed.stdout) == []


def test_importing_resident_runtime_does_not_import_solver_or_method_modules() -> None:
    script = (
        "import json, sys; import app.kernel.coordinator.run; import app.kernel.transport.handlers; "
        "print(json.dumps(sorted(name for name in sys.modules "
        "if name.startswith(('app.solvers.', 'app.methods.')))))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(completed.stdout) == []


def test_removed_import_paths_are_unavailable() -> None:
    for module in (
        "app.runtime", "app.handlers", "app.kernels", "app.program", "app.tensor", "app.errors",
        "app.runtime_kernel", "app.solver_framework",
    ):
        assert importlib.util.find_spec(module) is None, module


def test_catalog_locators_point_to_one_current_entry_per_solver() -> None:
    from app.kernel.catalog import solver_catalog

    manifests = solver_catalog.manifests()
    names = [item["descriptor"]["name"] for item in manifests]
    assert len(names) == len(set(names))
    for item in manifests:
        module, attribute = item["implementation"].split(":")
        assert re.fullmatch(r"app\.solvers\.[a-z_]+\.entry", module)
        assert attribute == "implementation"
        assert item["abiVersion"] == 3
