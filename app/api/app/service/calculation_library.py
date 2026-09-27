from __future__ import annotations

from typing import Any

from caemble_catalog import Catalog, CatalogNotFoundError, CatalogAmbiguousError
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from calculation_library_models import LibraryDetail, LibraryItem, LibraryPage, LibraryQuery, LibraryReference
from db import Calculation, CalculationExperimentRecord, Experiment, ExperimentDemo, ExperimentRecord
from models import UserData
from service.experiment_access import require_experiment_read


def _catalog_item(row: dict[str, Any]) -> LibraryItem:
    experiment = row["experiment"]
    return LibraryItem(
        reference=LibraryReference(kind="catalog", coordinate=experiment["coordinate"], name=row["name"]),
        name=row["name"], description=row["description"], experiment_name=experiment["title"],
        experiment_coordinate=experiment["coordinate"], sources=["catalog"],
        solvers=[{"name": solver["name"], "version": solver["version"]} for solver in experiment["relatedSolvers"]],
        concepts=experiment["concepts"], quantity_kinds=[],
    )


def _saved_item(row: Any, user: UserData | None, quantities: list[str]) -> LibraryItem:
    solvers = set()
    for result in (row.result_contracts or {}).values():
        solver = result.get("solver") if isinstance(result, dict) else None
        if isinstance(solver, dict) and isinstance(solver.get("name"), str) and isinstance(solver.get("version"), str):
            solvers.add((solver["name"], solver["version"]))
    return LibraryItem(
        reference=LibraryReference(kind="saved", calculation_id=row.id),
        name=row.name, description=row.description, experiment_name=row.experiment_name,
        experiment_coordinate=(f"caemble:experiment/{row.namespace}/{row.repository_slug}/{row.experiment_key}"
                               f"@{row.version_major}.{row.version_minor}.{row.version_patch}"),
        sources=(["mine"] if user is not None and row.user_id == user.id else []) + (["demo"] if row.demo_id is not None else []),
        solvers=[{"name": name, "version": version} for name, version in sorted(solvers)],
        concepts=[], quantity_kinds=sorted(set(quantities)),
    )


def _saved_query():
    return select(
        Calculation.id, Calculation.name, Calculation.description, Calculation.experiment_id,
        Experiment.name.label("experiment_name"), Experiment.user_id, Experiment.namespace,
        Experiment.repository_slug, Experiment.experiment_key, Experiment.version_major,
        Experiment.version_minor, Experiment.version_patch, Experiment.result_contracts,
        ExperimentDemo.experiment_id.label("demo_id"),
    ).join(Experiment, Experiment.id == Calculation.experiment_id).outerjoin(
        ExperimentDemo, ExperimentDemo.experiment_id == Experiment.id,
    )


async def list_library(db: AsyncSession, catalog: Catalog, query: LibraryQuery, user: UserData | None) -> LibraryPage:
    items = [_catalog_item(row) for row in catalog.calculation_summaries()] if query.source in ("all", "catalog") else []
    if query.source != "catalog":
        # The library deliberately contains only mine + public, even for admins.
        scope = ExperimentDemo.experiment_id.is_not(None)
        if query.source == "mine":
            if user is None:
                raise HTTPException(401, "Authentication required for mine scope.")
            scope = Experiment.user_id == user.id
        elif query.source == "all" and user is not None:
            scope = or_(scope, Experiment.user_id == user.id)
        rows = (await db.execute(_saved_query().where(scope))).all()
        quantities: dict[int, list[str]] = {}
        if rows:
            records = (await db.execute(select(
                CalculationExperimentRecord.calculation_id, ExperimentRecord.quantity_kind,
            ).join(ExperimentRecord, ExperimentRecord.id == CalculationExperimentRecord.experiment_record_id)
              .join(Calculation, Calculation.id == CalculationExperimentRecord.calculation_id)
              .where(Calculation.id.in_([row.id for row in rows]),
                     ExperimentRecord.experiment_id == Calculation.experiment_id))).all()
            for record in records:
                if record.quantity_kind:
                    quantities.setdefault(record.calculation_id, []).append(record.quantity_kind)
        items.extend(_saved_item(row, user, quantities.get(row.id, [])) for row in rows)
    facets = {
        "solvers": [{"name": name, "version": version} for name, version in sorted(
            {(solver.name, solver.version) for item in items for solver in item.solvers})],
        "concepts": sorted({concept for item in items for concept in item.concepts}),
        "quantity_kinds": sorted({kind for item in items for kind in item.quantity_kinds}),
    }
    needle = query.query.strip().casefold()
    matched = []
    for item in items:
        searchable = " ".join([item.name, item.description or "", item.experiment_name, item.experiment_coordinate])
        if needle and needle not in searchable.casefold():
            continue
        if query.concept and query.concept not in item.concepts:
            continue
        if query.unclassified and item.concepts:
            continue
        if query.quantity_kind and query.quantity_kind not in item.quantity_kinds:
            continue
        if (query.solver_name or query.solver_version) and not any(
            (not query.solver_name or solver.name == query.solver_name)
            and (not query.solver_version or solver.version == query.solver_version)
            for solver in item.solvers
        ):
            continue
        matched.append(item)
    matched.sort(key=lambda item: (item.name.casefold(), item.experiment_coordinate, item.reference.model_dump_json()))
    return LibraryPage(items=matched[query.offset:query.offset + query.limit], total=len(matched), facets=facets)


async def library_detail(db: AsyncSession, catalog: Catalog, reference: LibraryReference, user: UserData | None) -> LibraryDetail:
    if reference.kind == "catalog":
        if not reference.coordinate or not reference.name or reference.calculation_id is not None:
            raise HTTPException(422, "Catalog coordinate and Calculation name are required.")
        try:
            experiment = catalog.experiment(reference.coordinate, include_bundle=False)
            source = catalog.calculation_source(reference.coordinate, reference.name)
            row = next(row for row in catalog.calculation_summaries()
                       if row["experiment"]["coordinate"] == experiment["coordinate"] and row["name"] == reference.name)
        except (CatalogNotFoundError, CatalogAmbiguousError, StopIteration, ValueError) as error:
            raise HTTPException(404, "Calculation not found.") from error
        return LibraryDetail(**_catalog_item(row).model_dump(), source_code=source, inputs=[], inputs_verified=False,
                             output_layout=None, preflight_measurement_id=None, contract_status="unknown")
    if reference.calculation_id is None or reference.coordinate is not None or reference.name is not None:
        raise HTTPException(422, "Saved Calculation ID is required.")
    row = (await db.execute(_saved_query().add_columns(
        Calculation.source_id, Calculation.source_code, Calculation.output_layout, Calculation.contract_status,
        Calculation.preflight_measurement_id,
    ).where(Calculation.id == reference.calculation_id))).first()
    if row is None:
        raise HTTPException(404, "Calculation not found.")
    await require_experiment_read(db, row.experiment_id, user)
    records_query = select(ExperimentRecord.name, ExperimentRecord.dtype, ExperimentRecord.tensor_order,
                           ExperimentRecord.quantity_kind, ExperimentRecord.data_schema).where(
                               ExperimentRecord.experiment_id == row.experiment_id)
    ready = row.contract_status == "ready"
    if ready:
        records_query = records_query.join(CalculationExperimentRecord,
            CalculationExperimentRecord.experiment_record_id == ExperimentRecord.id).where(
                CalculationExperimentRecord.calculation_id == row.id)
    records = (await db.execute(records_query.order_by(ExperimentRecord.name))).mappings().all()
    return LibraryDetail(
        **_saved_item(row, user, [record["quantity_kind"] for record in records if record["quantity_kind"]]).model_dump(),
        source_id=row.source_id, source_code=row.source_code, inputs=list(records), inputs_verified=ready,
        output_layout=row.output_layout if ready else None,
        preflight_measurement_id=row.preflight_measurement_id if ready else None, contract_status=row.contract_status,
    )
