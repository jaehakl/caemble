import ast
import unittest
from pathlib import Path

from db import Experiment, GeometryPackage, GeometryRepository, GeometryVersion, Measurement
from models import ExperimentBase, GeometryModuleSnapshot, MeasurementBase
from tests.helpers import experiment_source_bundle


class TestCodeEntityContract(unittest.TestCase):
    def test_models_are_field_only_pydantic_contracts(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        source = (app_dir / "models.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                self.assertFalse(
                    any(
                        isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                        for item in node.body
                    ),
                    f"{node.name} must contain fields only.",
                )
        self.assertNotIn("field_validator", source)
        self.assertNotIn("model_validator", source)
        self.assertNotIn("field_serializer", source)
        self.assertFalse((app_dir / "geometry_contracts.py").exists())

    def test_geometry_router_is_a_thin_http_facade(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        source = (app_dir / "routers" / "geometry.py").read_text(encoding="utf-8")

        self.assertNotIn("from db import", source)
        self.assertNotIn("from sqlalchemy import", source)
        self.assertNotIn("CrudSpec", source)
        self.assertNotIn("get_list_response", source)
        self.assertNotIn("def _", source)

    def test_geometry_models_leave_format_validation_to_the_service(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        source = (app_dir / "models.py").read_text(encoding="utf-8")
        tree = ast.parse(source)

        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name.startswith("Geometry"):
                self.assertFalse(
                    any(
                        isinstance(item, ast.keyword) and item.arg == "pattern"
                        for item in ast.walk(node)
                    ),
                    f"{node.name} must not validate formats with Field(pattern=...).",
                )
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                names = (
                    [target.id for target in node.targets if isinstance(target, ast.Name)]
                    if isinstance(node, ast.Assign)
                    else [node.target.id] if isinstance(node.target, ast.Name) else []
                )
                self.assertFalse(
                    any(name.startswith("GEOMETRY_") and name.endswith("_PATTERN") for name in names)
                )

    def test_geometry_service_is_split_and_manager_lists_use_crud_utilities(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        service_dir = app_dir / "service" / "geometry"

        self.assertFalse((app_dir / "service" / "geometry.py").exists())
        self.assertEqual(
            {path.name for path in service_dir.glob("*.py")},
            {"__init__.py", "source.py", "graph.py", "manager.py", "publish.py"},
        )
        manager = (service_dir / "manager.py").read_text(encoding="utf-8")
        for reused_name in (
            "CrudSpec",
            "get_list_response",
            "normalize_int_ids",
            "get_scope_owner_ids",
        ):
            self.assertIn(reused_name, manager)
        self.assertNotIn("service.geometry.publish", manager)
        self.assertNotIn("service.geometry.manager", (service_dir / "graph.py").read_text(encoding="utf-8"))
        self.assertNotIn("service.geometry.graph", (service_dir / "source.py").read_text(encoding="utf-8"))

    def test_router_write_normalization_and_namespace_transactions_live_in_services(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        material_router = (app_dir / "routers" / "material.py").read_text(
            encoding="utf-8"
        )
        auth_router = (app_dir / "user_auth" / "routes.py").read_text(
            encoding="utf-8"
        )

        self.assertNotIn(".lower()", material_router)
        self.assertNotIn("GeometryRepository", auth_router)
        self.assertIn("change_geometry_namespace", auth_router)

    def test_material_routes_are_consolidated_without_changing_public_urls(self):
        app_dir = Path(__file__).resolve().parents[1] / "app"
        router_dir = app_dir / "routers"
        source = (router_dir / "material.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        routes = {
            (decorator.func.attr.upper(), ast.literal_eval(decorator.args[0]))
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            for decorator in node.decorator_list
            if isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr in {"post", "delete"}
        }

        self.assertEqual(
            routes,
            {
                (method, f"/{resource}{suffix}")
                for resource in (
                    "material",
                    "material_name",
                    "material_parameter",
                    "material_parameter_qualifier",
                )
                for method, suffix in (
                    ("POST", "/list"),
                    ("POST", "/upsert"),
                    ("DELETE", "/"),
                )
            },
        )
        for removed in (
            "material_name.py",
            "material_parameter.py",
            "material_parameter_qualifier.py",
        ):
            self.assertFalse((router_dir / removed).exists())
        self.assertNotIn("from db import", source)
        self.assertNotIn("CrudSpec", source)

        service_dir = app_dir / "service" / "material"
        self.assertFalse((app_dir / "service" / "material.py").exists())
        self.assertEqual(
            {path.name for path in service_dir.glob("*.py")},
            {"__init__.py", "manager.py", "source.py"},
        )

    def test_experiment_contract_exposes_server_source_hash(self):
        value = ExperimentBase.model_validate(
            {
                "name": "Experiment",
                "source_bundle": experiment_source_bundle(),
                "source_hash": "a" * 64,
            }
        )
        self.assertEqual(value.source_bundle.formatVersion, 5)
        self.assertEqual(
            value.model_dump(mode="json")["source_bundle"],
            experiment_source_bundle(),
        )
        self.assertEqual(value.source_hash, "a" * 64)
        self.assertNotIn("code_embedding", value.model_dump())
        self.assertFalse(Experiment.__table__.columns.source_hash.nullable)

    def test_current_geometry_contract_uses_module_v4_and_cad_api_v6(self):
        value = GeometryModuleSnapshot(
            geometryVersionId=1,
            coordinate="caemble:geometry/owner/common/shape@1.0.0",
            moduleFormatVersion=4,
            cadApiVersion=6,
            description=None,
            source="export const Shape = () => <box />",
            sourceHash="a" * 64,
            moduleHash="b" * 64,
        )
        self.assertEqual(value.moduleFormatVersion, 4)
        self.assertEqual(value.cadApiVersion, 6)
        constraints = {str(item.sqltext) for item in GeometryVersion.__table__.constraints if hasattr(item, "sqltext")}
        self.assertIn("module_format_version = 4", constraints)
        self.assertIn("cad_api_version = 6", constraints)

    def test_removed_split_tables_are_not_mapped(self):
        table_names = set(Experiment.metadata.tables)
        self.assertNotIn("structures", table_names)
        self.assertNotIn("samples", table_names)
        self.assertNotIn("setups", table_names)
        self.assertIn("experiments", table_names)
        self.assertIn("measurements", table_names)

    def test_geometry_contract_is_immutable_repository_package_version(self):
        table_names = set(Experiment.metadata.tables)
        self.assertNotIn("geometries", table_names)
        self.assertIn(GeometryRepository.__tablename__, table_names)
        self.assertIn(GeometryPackage.__tablename__, table_names)
        self.assertIn(GeometryVersion.__tablename__, table_names)
        self.assertNotIn("parent_id", GeometryVersion.__table__.columns)

    def test_measurement_contract_contains_complete_input_snapshot(self):
        value = MeasurementBase(
            user_id="00000000-0000-0000-0000-000000000001",
            experiment_id=1,
            vars={"width": 1},
            material_parameters={
                "schemaVersion": 2,
                "experiment": {"schemaVersion": 1, "materials": {}},
                "tasks": {"main": {"schemaVersion": 1, "materials": {}}},
            },
        )
        self.assertIsNone(value.recorded_at)
        self.assertIn("recorded_at", Measurement.__table__.columns)


if __name__ == "__main__":
    unittest.main()
