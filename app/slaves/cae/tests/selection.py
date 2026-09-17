"""Explicit CAE test ownership, independent of Solver registration and physics."""

from dataclasses import dataclass, field
import ast
from fnmatch import fnmatchcase
from pathlib import Path
import subprocess
from types import SimpleNamespace


CAE_PREFIX = "app/slaves/cae/"
PARTICLES = ("dem", "sph", "mpm")
SOLVER_TESTS = {
    "dc_current_density": ("test_actual_solver_chain", "test_coordinator_solver_chain", "test_solver_methods", "test_scalar_fem", "test_electrothermal_*", "test_microheater*", "test_box_grid_outputs"),
    "heat_transfer": ("test_actual_solver_chain", "test_coordinator_solver_chain", "test_solver_methods", "test_scalar_fem", "test_electrothermal_*", "test_microheater*", "test_box_grid_outputs"),
    "ray_tracing": ("test_ray_*", "test_spectrometer_example", "test_box_grid_outputs"),
    "fdtd": ("test_fdtd_*", "test_gold_fcc_example"),
    "structural_mechanics": ("test_structural_*", "test_electrothermal_*", "test_microheater*", "test_hyperelastic*", "test_mixed_*", "test_displacement_recording", "test_harmonic_*", "test_transient_*", "test_acoustic_transient_lifecycle"),
    "pressure_acoustics": ("test_acoustic_*", "test_pressure_acoustics", "test_harmonic_surface_methods", "test_transient_coupling_methods"),
    "rigid_body": ("test_rigid_*",),
    "dem": ("test_dem_*", "test_particle_final_review", "test_particle_*"),
    "sph": ("test_sph_*", "test_particle_*"),
    "mpm": ("test_particle_*",),
    "incompressible_flow": ("test_incompressible_*",),
}
# Specific method ownership takes precedence over a broad package rule.
METHOD_FILE_CONSUMERS = {
    "app/methods/coupling/clock.py": ("dc_current_density", "heat_transfer"),
    "app/methods/fields/history.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/mesh/interfaces.py": ("heat_transfer",),
    "app/methods/mesh/boundary.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/linalg/positive_definite.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/linalg/compensated.py": ("dc_current_density", "heat_transfer"),
    "app/methods/finite_element/scalar.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/mesh/subdomain.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/geometry/layered.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/coupling/assembly.py": ("dc_current_density", "heat_transfer", "structural_mechanics"),
    "app/methods/fields/tetrahedral.py": ("heat_transfer", "structural_mechanics"),
    "app/methods/finite_volume/tetrahedral.py": ("incompressible_flow",),
    "app/methods/coupling/tetrahedral.py": ("incompressible_flow",),
    "app/methods/coupling/polygons.py": ("incompressible_flow",),
}
METHOD_CONSUMERS = {
    "particles": PARTICLES,
    "continuum": ("structural_mechanics", "mpm"),
    "finite_element": ("structural_mechanics", "dc_current_density", "heat_transfer"),
    "rigid": ("structural_mechanics", "rigid_body", "dem"),
    "rays": ("ray_tracing",), "optics": ("ray_tracing",),
    "finite_volume": ("incompressible_flow",),
    "finite_difference": ("fdtd", "pressure_acoustics"),
    "mesh": ("structural_mechanics", "pressure_acoustics", "incompressible_flow", "dc_current_density", "heat_transfer"),
    "geometry": tuple(SOLVER_TESTS), "structured": tuple(SOLVER_TESTS),
    "fields": tuple(SOLVER_TESTS), "coupling": tuple(SOLVER_TESTS),
    "assembly": ("structural_mechanics", "dc_current_density", "heat_transfer"),
    "linalg": ("structural_mechanics", "pressure_acoustics", "incompressible_flow", "dc_current_density", "heat_transfer"),
    "nonlinear": ("structural_mechanics",), "time": ("structural_mechanics", "rigid_body", *PARTICLES),
}
KERNEL_TESTS = (
    "test_architecture_*", "test_*coordinator*", "test_coordinator_*", "test_*executor*",
    "test_*resource*", "test_*state*", "test_*contract*", "test_*recording",
    "test_value_*", "test_*transport", "test_object_storage", "test_preflight_execution",
    "test_solver_entries", "test_actual_solver_chain", "test_particle_field_handoff",
    "test_particle_runtime", "test_particle_faults", "test_rigid_runtime",
    "test_acoustic_transient_lifecycle", "test_regression_*",
    "test_incompressible_runtime", "test_incompressible_handoff",
    "test_result_metadata",
)
COMMON_TESTS = ("test_architecture_*", "test_solver_entries", "test_material_models", "test_material_interactions")

# Support ownership follows direct imports and child locators, including the
# transitive structural/scalar consumers of the shared geometry and grid fixtures.
TEST_SUPPORT_TESTS = {
    "fixtures/continuous-geometry.json": ("test_continuous_geometry",),
    "acoustic_fixtures.py": ("test_acoustic_fdtd_accuracy", "test_pressure_acoustics"),
    "box_grid_fixtures.py": ("test_*outputs", "test_*recording", "test_fdtd_*", "test_structural_*",
                             "test_hyperelastic*", "test_mixed_hyperelastic*", "test_scalar_fem",
                             "test_electrothermal_*", "test_result_metadata", "test_rigid_solver",
                             "test_solver_entries", "test_solver_methods", "test_transient_surface_motion"),
    "catalog_example_fixtures.py": ("test_catalog_examples", "test_hyperelastic_validation"),
    "coordinator_fixtures.py": ("test_simulation_coordinator", "test_box_grid_outputs"),
    "coordinator_value_fixtures.py": ("test_coordinator_values", "test_particle_field_handoff", "test_particle_quantities"),
    "dem_contract_fixtures.py": ("test_dem_contracts*",),
    "flow_fixtures.py": ("test_incompressible_*",),
    "geometry_fixtures.py": ("test_geometry_*", "test_particle_final_review", "test_particle_solvers", "test_rigid_solver", "test_scalar_fem"),
    "hyperelastic_fixtures.py": ("test_hyperelastic*",),
    "incompressible_handoff_fixtures.py": ("test_incompressible_handoff",),
    "local_transport_fixtures.py": ("test_local_transport",),
    "microheater_fixtures.py": ("test_microheater*",),
    "mixed_hyperelastic_fixtures.py": ("test_mixed_hyperelastic*",),
    "observer_fixtures.py": ("test_solver_observer",),
    "particle_fixtures.py": ("test_particle_*", "test_dem_particles", "test_coordinator_values", "test_resource_types_cache", "test_value_boundaries"),
    "resident_spawn_probe.py": ("test_spawn_executor",),
    "scalar_fixtures.py": ("test_scalar_fem", "test_electrothermal_*", "test_solver_entries", "test_solver_methods", "test_structural_thermal"),
    "solver_chain_fixtures.py": ("test_actual_solver_chain", "test_coordinator_solver_chain", "test_electrothermal_interface_child"),
    "sph_fixtures.py": ("test_particle_sph*",),
    "structural_clock_fixtures.py": ("test_structural_clock*",),
    "structural_csg_fixtures.py": ("test_structural_csg*",),
    "structural_fixture.py": ("test_structural_*", "test_hyperelastic*", "test_mixed_hyperelastic*", "test_transient_surface_motion"),
    "surface_fixtures.py": ("test_harmonic_surface_methods", "test_transient_coupling_methods"),
}
SHARED_TEST_SUPPORT = {
    "__init__.py", "run.py", "reporting.py", "selection.py", "tiers.py", "conftest.py",
    "catalog_build.py", "cli_build_observer.py", "example_runner.py", "solver_observer.py", "recording_fixtures.py",
    "solver_fixtures.py", "solver_test_support.py", "executor_transport_fixtures.py", "spawn_executor_fixtures.py",
}


@dataclass
class Selection:
    all_components: bool = False
    solvers: set[str] = field(default_factory=set)
    patterns: set[str] = field(default_factory=set)
    files: set[str] = field(default_factory=set)
    actions: set[str] = field(default_factory=set)
    reasons: dict[str, str] = field(default_factory=dict)
    ignored: dict[str, str] = field(default_factory=dict)


def changed_paths(repo: Path, base: str) -> list[str]:
    """Git's working-tree diff includes staged, unstaged, deleted and renamed paths."""
    tracked = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, "--"],
        cwd=repo, check=True, capture_output=True,
    ).stdout
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=repo, check=True, capture_output=True,
    ).stdout
    return sorted(set(part.decode("utf-8") for part in (tracked + untracked).split(b"\0") if part))


def select_changes(paths: list[str]) -> Selection:
    result = Selection()
    unknown = []
    for path in paths:
        reason = None
        if path.endswith(".md"):
            result.actions.add("docs")
            reason = "documentation checks"
        elif path.startswith("app/catalog/"):
            result.all_components = True
            result.actions.update(("catalog", "examples", "python-static"))
            reason = "Catalog contracts, official input builds and low-cost CAE contracts"
        elif path.startswith("app/sdk/"):
            result.all_components = True
            result.actions.add("python-static")
            reason = "shared SDK: low-cost CAE contracts"
        elif path.startswith("app/ui/"):
            result.actions.add("ui-static")
            if not path.endswith((".test.ts", ".test.tsx")) and path.startswith((
                "app/ui/src/lib/cad/", "app/ui/src/lib/catalog/", "app/ui/src/lib/material/",
                "app/ui/src/contracts/catalog", "app/ui/src/cli/",
                "app/ui/scripts/catalog-example-support", "app/ui/scripts/test-catalog-examples",
            )):
                result.actions.add("examples")
            reason = "UI static checks; authoring boundaries also build official example inputs"
        elif path.startswith(CAE_PREFIX):
            result.actions.add("python-static")
            local = path[len(CAE_PREFIX):]
            parts = local.split("/")
            if local in {"pyproject.toml", "poetry.lock", "manifest.json", "app/__init__.py", "app/__main__.py", "app/methods/__init__.py", "app/solvers/__init__.py"}:
                result.all_components = True
                reason = "CAE environment/entry point: all affected components within requested cost tiers"
            elif local.startswith("tests/"):
                if parts[-1].startswith("test_") and path.endswith(".py"):
                    result.files.add(local)
                    reason = "changed test module, subject to the requested cost tiers"
                elif local.removeprefix("tests/") in TEST_SUPPORT_TESTS:
                    result.patterns.update(TEST_SUPPORT_TESTS[local.removeprefix("tests/")])
                    reason = "test fixture and its consuming test family, within requested cost tiers"
                elif local.removeprefix("tests/") in SHARED_TEST_SUPPORT:
                    result.all_components = True
                    reason = "shared test infrastructure: all components within requested cost tiers"
                else:
                    unknown.append(path)
            elif local.startswith("app/kernel/"):
                result.patterns.update(KERNEL_TESTS)
                reason = "kernel contracts, ownership, transport and real child handoffs"
            elif local.startswith("app/solvers/") and len(parts) > 3 and parts[2] in {*SOLVER_TESTS, "steady_state_heat"}:
                # Deleted voxel Heat files belong to their replacement's checks.
                solver = "heat_transfer" if parts[2] == "steady_state_heat" else parts[2]
                result.solvers.add(solver)
                reason = f"{solver} tests and consuming interfaces"
            elif local in METHOD_FILE_CONSUMERS:
                consumers = METHOD_FILE_CONSUMERS[local]
                result.solvers.update(consumers)
                if local == "app/methods/fields/history.py":
                    result.patterns.add("test_field_history")
                reason = f"tetrahedral method and actual consumers: {', '.join(consumers)}"
            elif local.startswith("app/methods/") and len(parts) > 3 and parts[2] in METHOD_CONSUMERS:
                consumers = METHOD_CONSUMERS[parts[2]]
                result.solvers.update(consumers)
                result.patterns.update(("test_composable_methods", "test_geometry_*", "test_continuous_geometry", "test_structured_topology", "test_coupling_projection", "test_value_coupling", "test_particle_methods", "test_rigid_methods"))
                reason = f"shared {parts[2]} methods and consumers: {', '.join(consumers)}"
            elif local.startswith("benchmarks/"):
                reason = "standalone performance tool; outside pytest selection"
            else:
                unknown.append(path)
        else:
            result.ignored[path] = "outside CAE ownership; use the owning application's checks"
        if reason is not None:
            result.reasons[path] = reason
    if unknown:
        raise ValueError("No CAE test ownership rule for:\n" + "\n".join(unknown))
    if result.solvers:
        result.patterns.update(COMMON_TESTS)
        for solver in result.solvers:
            result.patterns.update(SOLVER_TESTS[solver])
    return result


def selected_item(item, selection: Selection, example_solvers: dict[str, set[str]],
                  allowed_tiers: set[str] | None = None, *, tier: str | None = None) -> str | None:
    """Select from collected items, so parameter identities and markers stay canonical."""
    from tests.tiers import test_tier

    effective_tier = tier or ("validation" if item.get_closest_marker("validation") is not None else test_tier(item.nodeid))
    if effective_tier not in (allowed_tiers or {"lowcost"}):
        return None
    filename = item.nodeid.split("::", 1)[0].replace("\\", "/")
    stem = Path(filename).stem
    if filename in selection.files:
        return "changed test module"
    if selection.all_components:
        return "affected shared dependency"
    if stem == "test_catalog_examples":
        if any(fnmatchcase(stem, pattern) for pattern in selection.patterns):
            return "affected Catalog test fixture"
        parameters = getattr(getattr(item, "callspec", None), "params", {})
        key = parameters.get("key")
        if key and selection.solvers & example_solvers.get(key, set()):
            return "official example for affected Solver"
        # Structural-specific lifecycle tests do not carry a Catalog key parameter.
        if key is None and "structural_mechanics" in selection.solvers:
            return "structural child lifecycle"
        return None
    if any(fnmatchcase(stem, pattern) for pattern in selection.patterns):
        if stem.startswith("test_particle_") and selection.solvers and not selection.all_components:
            parameters = getattr(getattr(item, "callspec", None), "params", {})
            particle_solver = parameters.get("prefix")
            example = parameters.get("particle_measurement")
            if example:
                particle_solver = (example[0] if isinstance(example, tuple) else example).split("-", 1)[0]
            if particle_solver in PARTICLES and particle_solver not in selection.solvers:
                return None
            original = getattr(item, "originalname", "") or ""
            named_solver = next((name for name in PARTICLES if original.startswith(f"test_{name}_")), None)
            if named_solver and named_solver not in selection.solvers:
                return None
            if stem in {"test_particle_mpm", "test_particle_sph", "test_particle_sph_validation", "test_particle_final_review"}:
                owner = {"test_particle_mpm": "mpm", "test_particle_sph": "sph",
                         "test_particle_sph_validation": "sph", "test_particle_final_review": "dem"}[stem]
                if owner not in selection.solvers:
                    return None
        return "affected component/consumer"
    return None


def affected_module(filename: str, selection: Selection) -> bool:
    """Narrow collection without importing the test modules being excluded."""
    stem = Path(filename).stem
    return (selection.all_components or filename in selection.files
            or any(fnmatchcase(stem, pattern) for pattern in selection.patterns)
            or (stem == "test_catalog_examples" and bool(selection.solvers)))


def collection_targets(selection: Selection | None, allowed_tiers: set[str]) -> tuple[list[str], dict[str, str]]:
    from tests.tiers import FUNCTION_TIERS, MODULE_TIERS, module_candidates

    cae = Path(__file__).resolve().parents[1]
    actual = {path.relative_to(cae).as_posix() for path in (cae / "tests").rglob("test_*.py")}
    missing, stale = actual - MODULE_TIERS.keys(), MODULE_TIERS.keys() - actual
    if missing or stale:
        raise ValueError("Test cost ownership does not match test modules:\n" +
                         "\n".join([*(f"Missing test cost ownership: {path}" for path in sorted(missing)),
                                    *(f"Stale test cost ownership: {path}" for path in sorted(stale))]))
    allowed_names = {"lowcost", "smoke", "validation", "example"}
    for name, tier in {**MODULE_TIERS, **FUNCTION_TIERS}.items():
        if tier not in allowed_names or name.split("::", 1)[0] not in actual:
            raise ValueError(f"Invalid test cost ownership: {name}={tier}")
    overrides = {key.split("::", 1)[0] for key in FUNCTION_TIERS}
    for filename in overrides:
        tree = ast.parse((cae / filename).read_text(encoding="utf-8"), filename=filename)
        functions = {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        stale_functions = [key for key in FUNCTION_TIERS if key.startswith(filename + "::")
                           and key.split("::")[-1] not in functions]
        if stale_functions:
            raise ValueError("Stale function cost ownership: " + ", ".join(stale_functions))
    candidates = set(module_candidates(allowed_tiers))
    affected = {filename for filename in MODULE_TIERS if selection is None or affected_module(filename, selection)}
    excluded = {filename: f"related {MODULE_TIERS[filename]} checks require explicit selection"
                for filename in sorted(affected - candidates)}
    return sorted(affected & candidates), excluded


def excluded_function_targets(targets: list[str], selection: Selection | None,
                              allowed_tiers: set[str]) -> dict[str, str]:
    """Explain expensive functions inside collected mixed modules without importing them."""
    from tests.tiers import FUNCTION_TIERS, MODULE_TIERS, test_tier

    requested = {target.split("[", 1)[0] for target in targets}
    candidates = {nodeid for nodeid in FUNCTION_TIERS
                  if nodeid.split("::", 1)[0] in requested or nodeid in requested}
    cae = Path(__file__).resolve().parents[1]
    for filename in requested & MODULE_TIERS.keys():
        if MODULE_TIERS[filename] in allowed_tiers:
            continue
        # A precision module may be collected only for its smoke overrides.
        # Its default-tier functions still need an explicit unrun explanation.
        tree = ast.parse((cae / filename).read_text(encoding="utf-8"), filename=filename)
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                candidates.add(f"{filename}::{node.name}")
            elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                candidates.update(f"{filename}::{node.name}::{method.name}" for method in node.body
                                  if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and method.name.startswith("test_"))
    excluded = {}
    for nodeid in sorted(candidates):
        function = nodeid.rsplit("::", 1)[-1]
        tier = test_tier(nodeid)
        if tier in allowed_tiers:
            continue
        item = SimpleNamespace(nodeid=nodeid, originalname=function, callspec=None,
                               get_closest_marker=lambda name: None)
        if selection is not None and not selected_item(item, selection, {}, {tier}, tier=tier):
            continue
        excluded[nodeid] = f"related {tier} check requires explicit selection"
    return excluded
