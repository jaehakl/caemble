"""Static ownership checks covering every API router, without importing the app."""
from __future__ import annotations

import ast
from pathlib import Path
import re
import unittest


APP_DIR = Path(__file__).resolve().parents[1] / "app"


class RouterArchitectureTests(unittest.TestCase):
    def test_all_routers_are_http_facades(self) -> None:
        transaction_methods = {"execute", "scalar", "scalars", "flush", "commit", "rollback"}
        sql_builders = {"select", "delete", "insert", "update", "func"}
        routers: set[str] = set()
        violations: list[str] = []
        for path in sorted(APP_DIR.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            if not any(
                isinstance(node, ast.Call)
                and isinstance(node.func, (ast.Name, ast.Attribute))
                and (node.func.id if isinstance(node.func, ast.Name) else node.func.attr) == "APIRouter"
                for node in ast.walk(tree)
            ):
                continue
            relative = path.relative_to(APP_DIR).as_posix()
            routers.add(relative)
            for node in ast.walk(tree):
                location = f"{relative}:{getattr(node, 'lineno', 1)}"
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [node.module or ""] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
                    for module in modules:
                        dependency_only = isinstance(node, ast.ImportFrom) and module == "db" and all(alias.name == "get_db" for alias in node.names)
                        if (module == "db" or module.endswith(".db")) and not dependency_only:
                            violations.append(f"{location} imports database models or sessions")
                        if module == "sqlalchemy" or (module.startswith("sqlalchemy.") and module not in {"sqlalchemy.ext.asyncio", "sqlalchemy.exc"}):
                            violations.append(f"{location} imports SQL implementation")
                elif isinstance(node, ast.Call):
                    if isinstance(node.func, ast.Name) and node.func.id in sql_builders:
                        violations.append(f"{location} builds SQL with {node.func.id}")
                    if isinstance(node.func, ast.Attribute):
                        if node.func.attr in transaction_methods:
                            violations.append(f"{location} calls {node.func.attr}()")
                        elif node.func.attr in {"add", "add_all", "get", "delete", "refresh"} and isinstance(node.func.value, ast.Name) and node.func.value.id in {"db", "session"}:
                            violations.append(f"{location} directly accesses a database session")
                elif isinstance(node, ast.Name) and node.id == "CrudSpec":
                    violations.append(f"{location} owns a CRUD specification")
        self.assertTrue(routers, "No routers were checked")
        for domain in ("simulation", "calculation", "catalog", "optimization", "storage", "user_auth", "gpstation"):
            self.assertTrue(any(path.startswith(f"{domain}/") for path in routers), f"No {domain} router was checked")
        self.assertEqual([], violations, "\n".join(violations))

    def test_gpstation_has_no_product_imports_or_policies(self) -> None:
        forbidden_modules = {"cae", "simulation", "optimization", "catalog", "caemble_catalog", "storage", "service", "routers", "models"}
        product_terms = re.compile(r"\b(?:cae|caemble|catalog|experiment|measurement|optimization|optimizations|trial|preflight)\b", re.IGNORECASE)
        product_names = {"Optimization", "Trial", "StageSubmission", "optimization_context", "exclude_optimizations", "optimization_id", "trial_id"}
        violations: list[str] = []
        for path in sorted((APP_DIR / "gpstation").rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                location = f"{path.relative_to(APP_DIR).as_posix()}:{getattr(node, 'lineno', 1)}"
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [node.module or ""] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
                    for module in modules:
                        if module.split(".", 1)[0] in forbidden_modules:
                            violations.append(f"{location} imports {module}")
                elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                    if node.value in product_names or product_terms.search(node.value):
                        violations.append(f"{location} contains product-specific text {node.value!r}")
                elif isinstance(node, ast.Name) and node.id in product_names:
                    violations.append(f"{location} references {node.id}")
                elif isinstance(node, ast.arg) and node.arg in product_names:
                    violations.append(f"{location} has product-specific argument {node.arg}")
        self.assertEqual([], violations, "\n".join(violations))

    def test_retired_catch_all_packages_are_not_restored(self) -> None:
        for name in ("cae", "routers", "service", "models.py", "catalog_models.py", "calculation_library_models.py"):
            self.assertFalse((APP_DIR / name).exists(), f"Use the owning domain instead of app/{name}")

    def test_core_does_not_depend_on_domains(self) -> None:
        domains = {"simulation", "calculation", "optimization", "catalog", "caemble_catalog", "storage", "user_auth", "gpstation"}
        violations: list[str] = []
        for path in sorted((APP_DIR / "core").rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [node.module or ""] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
                    for module in modules:
                        if module.split(".", 1)[0] in domains:
                            violations.append(f"{path.relative_to(APP_DIR).as_posix()}:{node.lineno} imports {module}")
        self.assertEqual([], violations, "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
