from __future__ import annotations

import ast
import unittest
from pathlib import Path


ROUTER_DIR = Path(__file__).resolve().parents[1] / "app" / "routers"


class RouterArchitectureTests(unittest.TestCase):
    def test_routers_are_http_facades(self) -> None:
        transaction_methods = {
            "execute",
            "scalar",
            "scalars",
            "flush",
            "commit",
            "rollback",
        }
        sql_builders = {"select", "delete", "insert", "update", "func"}
        violations: list[str] = []
        for path in sorted(ROUTER_DIR.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    if module == "db" or module.startswith("db."):
                        violations.append(f"{path.name}:{node.lineno} imports DB models")
                    if module == "sqlalchemy" or module.startswith("sqlalchemy.dialects"):
                        violations.append(f"{path.name}:{node.lineno} imports SQL builders")
                elif isinstance(node, ast.Call):
                    if isinstance(node.func, ast.Name) and node.func.id in sql_builders:
                        violations.append(
                            f"{path.name}:{node.lineno} builds SQL with {node.func.id}"
                        )
                    if (
                        isinstance(node.func, ast.Attribute)
                        and node.func.attr in transaction_methods
                    ):
                        violations.append(
                            f"{path.name}:{node.lineno} calls {node.func.attr}()"
                        )
                elif isinstance(node, ast.Name) and node.id == "CrudSpec":
                    violations.append(f"{path.name}:{node.lineno} owns a CRUD spec")
        self.assertEqual([], violations, "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
