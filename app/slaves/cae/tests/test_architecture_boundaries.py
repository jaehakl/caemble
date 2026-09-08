from __future__ import annotations

import ast
import json
import importlib.util
import re
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
        *sorted((APP / "kernel" / "coordinator").rglob("*.py")),
        *sorted((APP / "kernel" / "transport").rglob("*.py")),
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
                module.startswith("app.kernel.")
                and not module.startswith("app.kernel.api")
            )
        )
        for path in (APP / "methods").rglob("*.py")
    }
    assert not {path: modules for path, modules in violations.items() if modules}


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


def test_methods_and_solvers_do_not_use_internal_resource_exports() -> None:
    internal_exports = {
        "ArtifactHandle", "ArtifactProvenance", "ArtifactStore", "BufferStore",
        "BufferLease", "Field", "FileResourceCache", "ImmutableResourceCache",
        "LegacySolverAdapter", "ResourceLease", "ResourceRef", "ResourceStore",
        "ResourceTreeRef", "StateHandle", "StateRevision", "StateStore", "StateView",
    }
    violations: dict[str, list[str]] = {}
    for directory in (APP / "methods", APP / "solvers"):
        for path in directory.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imports = imported_modules(path)
            found = sorted(
                module for module in imports
                if module.startswith("app.kernel.")
                and not module.startswith("app.kernel.api")
            )
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module in {
                    "app.kernel.api", "app.kernel.api.models",
                }:
                    found.extend(
                        f"{node.module}.{alias.name}"
                        for alias in node.names
                        if alias.name in internal_exports or alias.name == "*"
                    )
            if found:
                violations[str(path.relative_to(APP))] = found
    assert not violations


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


def test_app_exposes_only_entry_files_and_current_packages() -> None:
    assert {path.name for path in APP.glob("*.py")} == {"__init__.py", "__main__.py"}
    assert {path.name for path in APP.iterdir() if path.is_dir() and path.name != "__pycache__"} == {
        "kernel", "methods", "solvers",
    }
    for path in (APP / "solvers").rglob("*.py"):
        assert not any(re.fullmatch(r"v\d+_\d+_\d+", part) for part in path.parts)
        assert not path.stem.endswith("_impl")


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
        entry = APP.parent / (module.replace(".", "/") + ".py")
        tree = ast.parse(entry.read_text(encoding="utf-8"))
        run = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "run")
        assert any(
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "SolverResult"
            for node in ast.walk(run)
        ), f"{entry} must show how the final result is assembled"


def test_solver_role_modules_have_no_cycles_or_other_solver_dependencies() -> None:
    for package in (APP / "solvers").iterdir():
        if not package.is_dir() or package.name == "__pycache__":
            continue
        prefix = f"app.solvers.{package.name}"
        graph = {}
        for path in package.glob("*.py"):
            module = f"{prefix}.{path.stem}"
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imports = []
            pending = list(tree.body)
            while pending:
                node = pending.pop()
                if isinstance(node, ast.If) and (
                    isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING"
                ):
                    continue
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    imports.append(node)
                pending.extend(ast.iter_child_nodes(node))
            dependencies = set()
            for node in imports:
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                else:
                    assert all(alias.name != "*" for alias in node.names), str(path)
                    if node.level:
                        assert node.level == 1, f"{path} imports another Solver"
                        modules = [f"{prefix}.{node.module}"] if node.module else [f"{prefix}.{alias.name}" for alias in node.names]
                    else:
                        modules = [node.module or ""]
                for imported in modules:
                    if imported.startswith("app.solvers."):
                        assert imported.startswith(prefix + "."), f"{path} imports {imported}"
                        assert path.stem == "entry" or imported != prefix + ".entry", f"{path} imports its entry"
                        dependencies.add(imported)
            graph[module] = dependencies

        def visit(module: str, ancestors: tuple[str, ...]) -> None:
            assert module not in ancestors, " -> ".join((*ancestors, module))
            for dependency in graph.get(module, ()):
                visit(dependency, (*ancestors, module))

        for module in graph:
            visit(module, ())
