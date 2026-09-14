from __future__ import annotations

import ast
import json
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest


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


def local_python_modules(directory: Path) -> set[str]:
    """Include real modules, regular packages and their namespace-package parents."""
    modules = set()
    for path in directory.rglob("*.py"):
        parts = (directory.name, *path.relative_to(directory).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        modules.update(".".join(parts[:length]) for length in range(1, len(parts) + 1))
    return modules


def resolve_import_modules(node, import_package: str, available: set[str]) -> set[str]:
    """A from-import loads its base and any imported names that are actual modules."""
    if isinstance(node, ast.Import):
        return {alias.name for alias in node.names}
    if node.level:
        imported = importlib.util.resolve_name("." * node.level + (node.module or ""), import_package)
    else:
        imported = node.module or ""
    modules = {imported}
    for alias in node.names:
        candidate = f"{imported}.{alias.name}"
        if candidate in available:
            modules.add(candidate)
    return modules


def assert_solver_role_dependencies(app_directory: Path) -> None:
    available = local_python_modules(app_directory)
    for package in (app_directory / "solvers").iterdir():
        if not package.is_dir() or package.name == "__pycache__":
            continue
        prefix = f"app.solvers.{package.name}"
        graph = {}
        for path in package.rglob("*.py"):
            relative = path.relative_to(package).with_suffix("").parts
            if relative[-1] == "__init__":
                relative = relative[:-1]
            module = ".".join((prefix, *relative))
            import_package = module if path.stem == "__init__" else module.rsplit(".", 1)[0]
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
                if isinstance(node, ast.ImportFrom):
                    assert all(alias.name != "*" for alias in node.names), str(path)
                for imported in resolve_import_modules(node, import_package, available):
                    if imported.startswith("app.solvers."):
                        assert imported == prefix or imported.startswith(prefix + "."), f"{path} imports {imported}"
                        assert path.stem == "entry" or imported != prefix + ".entry", f"{path} imports its entry"
                        if package.name == "structural_mechanics":
                            relative_module = module.removeprefix(prefix + ".")
                            if relative_module.startswith(("analyses.", "operators.", "interfaces.")) or relative_module in {"analyses", "operators", "interfaces", "state", "kinematics"}:
                                assert not imported.startswith(prefix + ".outputs"), f"{path} imports result packaging"
                            if relative_module == "analyses.harmonic":
                                assert imported not in {prefix + ".state", prefix + ".analyses.transient", prefix + ".analyses.window"}, f"{path} imports time-state execution"
                        if package.name == "pressure_acoustics":
                            if path.stem in {"harmonic", "formulation", "boundaries"}:
                                assert not imported.startswith(prefix + ".outputs"), f"{path} imports result packaging"
                            if path.stem == "harmonic":
                                assert imported not in {prefix + ".entry", prefix + ".domain"}, f"{path} imports task preparation"
                        # A package importing one of its children does not depend on itself.
                        if not (path.stem == "__init__" and isinstance(node, ast.ImportFrom) and imported == module):
                            dependencies.add(imported)
            graph[module] = dependencies

        def visit(module: str, ancestors: tuple[str, ...]) -> None:
            assert module not in ancestors, " -> ".join((*ancestors, module))
            for dependency in graph.get(module, ()):
                visit(dependency, (*ancestors, module))

        for module in graph:
            visit(module, ())


def test_solver_role_modules_have_no_cycles_or_other_solver_dependencies() -> None:
    assert_solver_role_dependencies(APP)


@pytest.fixture
def solver_import_fixture(tmp_path):
    app = tmp_path / "app"
    files = {
        "solvers/structural_mechanics/__init__.py": "",
        "solvers/structural_mechanics/entry.py": "",
        "solvers/structural_mechanics/model.py": "class Motion: pass\n",
        "solvers/structural_mechanics/interfaces/__init__.py": "",
        "solvers/structural_mechanics/interfaces/motion.py": "from ..model import Motion\n",
        "solvers/structural_mechanics/outputs/__init__.py": "",
        "solvers/structural_mechanics/outputs/display.py": "",
        "solvers/pressure_acoustics/__init__.py": "",
        "solvers/pressure_acoustics/entry.py": "",
    }
    for name, source in files.items():
        path = app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
    return app


@pytest.mark.parametrize(("source", "package", "expected"), [
    ("from .interfaces import motion as movement", "app.solvers.structural_mechanics",
     {"app.solvers.structural_mechanics.interfaces", "app.solvers.structural_mechanics.interfaces.motion"}),
    ("from .. import model", "app.solvers.structural_mechanics.interfaces",
     {"app.solvers.structural_mechanics", "app.solvers.structural_mechanics.model"}),
    ("from ..model import Motion as State", "app.solvers.structural_mechanics.interfaces",
     {"app.solvers.structural_mechanics.model"}),
    ("from app.solvers import pressure_acoustics as sound", "app.solvers.structural_mechanics",
     {"app.solvers", "app.solvers.pressure_acoustics"}),
])
def test_import_resolution_uses_actual_modules_and_relative_package_depth(solver_import_fixture, source, package, expected):
    node = ast.parse(source).body[0]
    assert resolve_import_modules(node, package, local_python_modules(solver_import_fixture)) == expected


def test_package_alias_edges_reveal_a_nested_cycle(solver_import_fixture):
    package = solver_import_fixture / "solvers/structural_mechanics"
    (package / "model.py").write_text("from .interfaces import motion\n", encoding="utf-8")
    with pytest.raises(AssertionError, match=r"interfaces\.motion.*model|model.*interfaces\.motion"):
        assert_solver_role_dependencies(solver_import_fixture)


def test_package_initializer_can_import_its_child_without_a_false_self_cycle(solver_import_fixture):
    path = solver_import_fixture / "solvers/structural_mechanics/interfaces/__init__.py"
    path.write_text("from . import motion\n", encoding="utf-8")
    assert_solver_role_dependencies(solver_import_fixture)


def test_import_from_solver_namespace_rejects_another_solver(solver_import_fixture):
    path = solver_import_fixture / "solvers/structural_mechanics/interfaces/motion.py"
    path.write_text("from app.solvers import pressure_acoustics as sound\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="imports app.solvers.pressure_acoustics"):
        assert_solver_role_dependencies(solver_import_fixture)


@pytest.mark.parametrize("source", ["from .. import outputs", "from ..outputs import display as view"])
@pytest.mark.parametrize("filename", ["motion.py", "__init__.py"])
def test_interface_modules_cannot_import_output_packaging(solver_import_fixture, source, filename):
    path = solver_import_fixture / "solvers/structural_mechanics/interfaces" / filename
    path.write_text(source, encoding="utf-8")
    with pytest.raises(AssertionError, match="imports result packaging"):
        assert_solver_role_dependencies(solver_import_fixture)
