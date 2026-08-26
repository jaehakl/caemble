from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path


APP = Path(__file__).parents[1] / "app"


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def test_resident_coordinator_has_no_method_or_solver_dependency() -> None:
    paths = [
        *sorted((APP / "runtime_kernel" / "coordinator").glob("*.py")),
    ]
    forbidden = ("app.methods", "app.solvers", "app.solver_framework")
    violations = {
        str(path.relative_to(APP)): sorted(
            module for module in imported_modules(path) if module.startswith(forbidden)
        )
        for path in paths
    }
    assert not {path: modules for path, modules in violations.items() if modules}


def test_methods_have_no_solver_or_coordinator_dependency() -> None:
    forbidden = ("app.solvers", "app.solver_framework")
    violations = {
        str(path.relative_to(APP)): sorted(
            module
            for module in imported_modules(path)
            if module.startswith(forbidden)
            or (
                module.startswith("app.runtime_kernel.")
                and not module.startswith("app.runtime_kernel.api")
            )
        )
        for path in (APP / "methods").rglob("*.py")
    }
    assert not {path: modules for path, modules in violations.items() if modules}


def test_importing_resident_runtime_does_not_import_solver_or_method_modules() -> None:
    script = (
        "import json, sys; import app.runtime; "
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


def test_versioned_solver_packages_do_not_import_unversioned_solver_modules() -> None:
    packages = {
        APP / "solvers" / "dc_current_density" / "v0_3_0": (
            "app.solvers.dc_current_density",
            "app.solvers.dc_current_density.v0_3_0",
        ),
        APP / "solvers" / "steady_state_heat" / "v0_2_0": (
            "app.solvers.steady_state_heat",
            "app.solvers.steady_state_heat.v0_2_0",
        ),
        APP / "solvers" / "ray_tracing" / "v0_2_0": (
            "app.solvers.ray_tracing",
            "app.solvers.ray_tracing.v0_2_0",
        ),
    }
    violations = {
        str(path.relative_to(APP)): [
            *sorted(
                module
                for module in imported_modules(path)
                if module.startswith(root_prefix)
                and not module.startswith(version_prefix)
            ),
            *(
                ["relative import escapes version package"]
                if any(
                    isinstance(node, ast.ImportFrom) and node.level > 1
                    for node in ast.walk(
                        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                    )
                )
                else []
            ),
        ]
        for package, (root_prefix, version_prefix) in packages.items()
        for path in package.glob("*.py")
    }
    assert not {path: modules for path, modules in violations.items() if modules}
