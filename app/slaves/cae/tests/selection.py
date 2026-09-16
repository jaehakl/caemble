"""Explicit CAE test ownership, independent of Solver registration and physics."""

from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path
import subprocess


CAE_PREFIX = "app/slaves/cae/"
PARTICLES = ("dem", "sph", "mpm")
SOLVER_TESTS = {
    "dc_current_density": ("test_actual_solver_chain", "test_solver_methods", "test_box_grid_outputs"),
    "steady_state_heat": ("test_actual_solver_chain", "test_solver_methods", "test_coupling_projection", "test_box_grid_outputs"),
    "ray_tracing": ("test_ray_*", "test_spectrometer_example", "test_box_grid_outputs"),
    "fdtd": ("test_fdtd_*", "test_gold_fcc_example"),
    "structural_mechanics": ("test_structural_*", "test_hyperelastic", "test_mixed_*", "test_displacement_recording", "test_harmonic_*", "test_transient_*", "test_acoustic_transient_lifecycle"),
    "pressure_acoustics": ("test_acoustic_*", "test_pressure_acoustics", "test_harmonic_surface_methods", "test_transient_coupling_methods"),
    "rigid_body": ("test_rigid_*",),
    "dem": ("test_dem_*", "test_particle_final_review", "test_particle_*"),
    "sph": ("test_sph_*", "test_particle_*"),
    "mpm": ("test_particle_*",),
    "incompressible_flow": ("test_incompressible_*",),
}
# These new tetrahedral methods currently have only one consumer. Broad ownership
# would select unrelated long FEM/particle validation for a CFD-only addition.
METHOD_FILE_CONSUMERS = {
    "app/methods/finite_volume/tetrahedral.py": ("incompressible_flow",),
    "app/methods/coupling/tetrahedral.py": ("incompressible_flow",),
    "app/methods/coupling/polygons.py": ("incompressible_flow",),
}
METHOD_CONSUMERS = {
    "particles": PARTICLES,
    "continuum": ("structural_mechanics", "mpm"),
    "finite_element": ("structural_mechanics",),
    "rigid": ("structural_mechanics", "rigid_body", "dem"),
    "rays": ("ray_tracing",), "optics": ("ray_tracing",),
    "finite_volume": ("dc_current_density", "steady_state_heat", "incompressible_flow"),
    "finite_difference": ("fdtd", "pressure_acoustics"),
    "mesh": ("structural_mechanics", "pressure_acoustics", "incompressible_flow"),
    "geometry": tuple(SOLVER_TESTS), "structured": tuple(SOLVER_TESTS),
    "fields": tuple(SOLVER_TESTS), "coupling": tuple(SOLVER_TESTS),
    "assembly": ("structural_mechanics", "dc_current_density", "steady_state_heat"),
    "linalg": ("structural_mechanics", "dc_current_density", "steady_state_heat", "pressure_acoustics", "incompressible_flow"),
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
COMMON_TESTS = ("test_architecture_boundaries", "test_solver_entries", "test_material_models", "test_material_interactions")


@dataclass
class Selection:
    quick: bool = False
    solvers: set[str] = field(default_factory=set)
    patterns: set[str] = field(default_factory=set)
    files: set[str] = field(default_factory=set)
    validation: bool = False
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
            result.quick = True
            result.actions.update(("catalog", "examples"))
            reason = "Catalog validation, official example builds and CPU quick"
        elif path.startswith("app/sdk/"):
            result.quick = True
            reason = "shared SDK: CPU quick"
        elif path.startswith("app/ui/"):
            result.actions.add("ui")
            if not path.endswith((".test.ts", ".test.tsx")):
                result.actions.add("examples")
                result.quick = True
            reason = "UI contracts; authoring changes also build official examples and run CPU quick"
        elif path.startswith(CAE_PREFIX):
            local = path[len(CAE_PREFIX):]
            parts = local.split("/")
            if local in {"pyproject.toml", "poetry.lock", "manifest.json", "app/__init__.py", "app/__main__.py", "app/methods/__init__.py", "app/solvers/__init__.py"}:
                result.quick = True
                reason = "CAE environment/entry point: CPU quick"
            elif local.startswith("tests/"):
                if parts[-1].startswith("test_") and path.endswith(".py"):
                    result.files.add(local)
                    reason = "changed test module (including its validation cases)"
                else:
                    result.quick = True
                    reason = "shared test infrastructure: CPU quick"
            elif local.startswith("app/kernel/"):
                result.patterns.update(KERNEL_TESTS)
                reason = "kernel contracts, ownership, transport and real child handoffs"
            elif local.startswith("app/solvers/") and len(parts) > 3 and parts[2] in SOLVER_TESTS:
                solver = parts[2]
                result.solvers.add(solver)
                # Output/visualization edits do not change convergence or long-time physics.
                if (solver in {"structural_mechanics", "pressure_acoustics", "incompressible_flow"}
                        and not any(part in {"outputs", "outputs.py"} for part in parts[3:])):
                    result.validation = True
                reason = f"{solver} tests and consuming interfaces"
            elif local in METHOD_FILE_CONSUMERS:
                consumers = METHOD_FILE_CONSUMERS[local]
                result.solvers.update(consumers)
                result.validation = True
                reason = f"tetrahedral method and actual consumers: {', '.join(consumers)}"
            elif local.startswith("app/methods/") and len(parts) > 3 and parts[2] in METHOD_CONSUMERS:
                consumers = METHOD_CONSUMERS[parts[2]]
                result.solvers.update(consumers)
                result.patterns.update(("test_composable_methods", "test_geometry_*", "test_structured_topology", "test_coupling_projection", "test_value_coupling", "test_particle_methods", "test_rigid_methods"))
                result.validation |= parts[2] not in {"fields", "particles", "rays", "optics"}
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


def selected_item(item, selection: Selection, example_solvers: dict[str, set[str]]) -> str | None:
    """Select from collected items, so parameter identities and markers stay canonical."""
    validation = item.get_closest_marker("validation") is not None
    filename = item.nodeid.split("::", 1)[0].replace("\\", "/")
    stem = Path(filename).stem
    if filename in selection.files:
        return "changed test module"
    if selection.quick and not validation:
        return "CPU quick dependency"
    if validation and not selection.validation:
        return None
    if stem == "test_catalog_examples":
        parameters = getattr(getattr(item, "callspec", None), "params", {})
        key = parameters.get("key")
        if key and selection.solvers & example_solvers.get(key, set()):
            return "official example for affected Solver"
        # Structural-specific lifecycle tests do not carry a Catalog key parameter.
        if key is None and "structural_mechanics" in selection.solvers:
            return "structural child lifecycle"
        return None
    if any(fnmatchcase(stem, pattern) for pattern in selection.patterns):
        if stem.startswith("test_particle_") and selection.solvers and not selection.quick:
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
            if stem in {"test_particle_mpm", "test_particle_sph", "test_particle_final_review"}:
                owner = {"test_particle_mpm": "mpm", "test_particle_sph": "sph", "test_particle_final_review": "dem"}[stem]
                if owner not in selection.solvers:
                    return None
        return "affected component/consumer"
    return None
