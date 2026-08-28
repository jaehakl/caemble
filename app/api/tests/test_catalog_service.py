from __future__ import annotations

import sys
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

from catalog_models import CatalogRuntimeSliceRequest  # noqa: E402
from service.catalog import (  # noqa: E402
    build_runtime_slice,
    get_quantity_kind,
    list_quantity_kinds,
    search_catalog,
)


class FakeCatalog:
    def __init__(self) -> None:
        self.quantity_kind_offsets: list[int] = []
        self.runtime_arguments = None

    def meta(self):
        return {"catalogRevision": "revision-7"}

    def list_quantity_kinds(self, **kwargs):
        offset = kwargs["offset"]
        limit = kwargs["limit"]
        self.quantity_kind_offsets.append(offset)
        rows = [{"name": f"kind-{index}"} for index in range(5)]
        return rows[offset : offset + limit], len(rows)

    def quantity_kind(self, name):
        return {"name": name, "domain": "mechanical"}

    def quantity_kind_relations(self, name):
        return {"materialParameters": [f"{name}/density"], "solverUsages": []}

    def search(self, query, *, limit):
        return [{"kind": "quantity-kind", "key": query}][:limit]

    def runtime_slice(self, **kwargs):
        self.runtime_arguments = kwargs
        return {"catalogRevision": "revision-7", "solvers": []}


class CatalogServiceTests(unittest.TestCase):
    def test_cursor_pagination_uses_runtime_offsets(self) -> None:
        catalog = FakeCatalog()
        first, revision = list_quantity_kinds(
            catalog,  # type: ignore[arg-type]
            query=None,
            domain=None,
            solver_name=None,
            solver_version=None,
            usage=None,
            unit=None,
            tensor_order=None,
            limit=2,
            cursor=None,
        )
        second, _ = list_quantity_kinds(
            catalog,  # type: ignore[arg-type]
            query=None,
            domain=None,
            solver_name=None,
            solver_version=None,
            usage=None,
            unit=None,
            tensor_order=None,
            limit=2,
            cursor=first["nextCursor"],
        )
        self.assertEqual("revision-7", revision)
        self.assertEqual([0, 2], catalog.quantity_kind_offsets)
        self.assertEqual(["kind-2", "kind-3"], [item["name"] for item in second["items"]])

    def test_detail_search_and_runtime_slice_are_composed_in_service(self) -> None:
        catalog = FakeCatalog()
        detail, revision = get_quantity_kind(
            catalog,  # type: ignore[arg-type]
            "stress",
        )
        search, _ = search_catalog(catalog, "stress", limit=3)  # type: ignore[arg-type]
        runtime, _ = build_runtime_slice(
            catalog,  # type: ignore[arg-type]
            CatalogRuntimeSliceRequest(
                solvers=[{"name": "solver", "version": "1"}],
                quantityKinds=["stress"],
                materialParameters=["density"],
                materialModels=["elastic"],
            ),
        )
        self.assertEqual("revision-7", revision)
        self.assertEqual(["stress/density"], detail["materialParameters"])
        self.assertEqual("stress", search["items"][0]["key"])
        self.assertEqual("revision-7", runtime["catalogRevision"])
        self.assertEqual(
            {
                "solvers": [("solver", "1")],
                "quantity_kinds": ["stress"],
                "material_parameters": ["density"],
                "material_models": ["elastic"],
            },
            catalog.runtime_arguments,
        )


if __name__ == "__main__":
    unittest.main()
