"""One-time Catalog authoring via the supported catalogctl command entrypoint."""
import contextlib
import io
import json
import sys
from pathlib import Path

from caemble_catalog import open_catalog
from caemble_catalog.cli import main as catalogctl

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(__file__).resolve().parent
DRAFT = WORK / "acoustic-transient.sqlite3"
CANONICAL = ROOT / "app/catalog/caemble_catalog/catalog.sqlite3"


def command(*args):
    argv = ["--database", str(DRAFT), *map(str, args)]
    with contextlib.redirect_stdout(io.StringIO()):
        result = catalogctl(argv)
    if result:
        raise RuntimeError(f"catalogctl failed: {args}")


def parameter(name, version, key, description, data, *, method=None, optional=False):
    args = ["solver", "method-parameter" if method else "parameter", "upsert", name, version]
    if method:
        args.extend(method)
    args.extend([key, "--description", description, "--data-json", json.dumps(data)])
    if optional:
        args.append("--no-required")
    command(*args)


def method(name, version, category, key, description, *, kind="geometry", source="experiment", target_count=0, max_targets=None, minimum=0, maximum=1, artifact=None, data=None):
    args = ["solver", "method", "upsert", name, version, category, key,
            "--description", description, "--minimum-occurrences", minimum, "--maximum-occurrences", maximum,
            "--target-source", source, "--target-kind", kind, "--minimum-targets", target_count,
            "--maximum-targets", target_count if max_targets is None else max_targets,
            "--minimum-resolved", target_count, "--maximum-resolved", target_count if max_targets is None else max_targets]
    if artifact:
        args.extend(["--artifact-type", artifact, "--data-json", json.dumps(data)])
    command(*args)


def scalar(quantity, unit, **limits):
    return {"dtype": "float64", "tensorOrder": 0, "quantityKind": quantity, "unit": unit, **limits}


def publish_example(example, *, old=None):
    bundle = WORK / f"{example['key']}.json"
    calculations = WORK / f"{example['key']}-calculations.json"
    bundle.write_text(json.dumps(example["sourceBundle"], ensure_ascii=False, indent=2), encoding="utf-8")
    calculations.write_text(json.dumps(example.get("calculations", []), ensure_ascii=False, indent=2), encoding="utf-8")
    args = ["experiment", "upsert", example["key"], "--namespace", example["namespace"],
            "--repository", example["repository"], "--version", example["version"],
            "--title", example["title"], "--description", example["description"],
            "--bundle-file", bundle, "--calculations-file", calculations]
    for concept in example.get("concepts", []):
        args.extend(["--concept", concept])
    for solver in example["relatedSolvers"]:
        args.extend(["--solver", f"{solver['name']}@{solver['version']}"])
    command(*args)
    if old:
        command("experiment", "remove", old)


def update_contracts():
    command("draft", "create", "--source", CANONICAL)
    command("rebase")
    command("solver", "clone", "structural-mechanics", "6.0.0", "6.1.0")
    command("solver", "clone", "pressure-acoustics", "1.0.0", "1.1.0")
    with open_catalog(DRAFT) as catalog:
        structural = catalog.get_solver_manifest("structural-mechanics", "6.0.0")["descriptor"]
        acoustic = catalog.get_solver_manifest("pressure-acoustics", "1.0.0")["descriptor"]
    command("solver", "set-metadata", "structural-mechanics", "6.1.0", "--description",
            structural["description"] + " Exports actual converged transient reference-surface velocity samples separately from next-window coupling predictions.")
    command("solver", "set-metadata", "pressure-acoustics", "1.1.0", "--description",
            "Linear pressure acoustics in a homogeneous stationary fluid. Harmonic tet4 FEM retains peak exp(+i*omega*t) phasors; transient CPU float64 staggered FDTD supports an axis-aligned Box, rigid walls, prescribed outward velocity, positive resistive impedance and actual planar structural surface motion. One-way small-motion coupling and run-scoped checkpoints; no PML or fluid feedback.")
    parameter("pressure-acoustics", "1.1.0", "analysis", "harmonic (default) or transient; each analysis has distinct methods and result contracts.",
              {"dtype": "string", "tensorOrder": 0, "values": ["harmonic", "transient"]}, optional=True)
    parameter("pressure-acoustics", "1.1.0", "spatialResolution", "Target maximum tetrahedral edge for harmonic FEM or maximum Cartesian cell spacing for transient FDTD; the exact primitive dimensions are preserved.", scalar("Length", "m", minimum=0, exclusiveMinimum=True))
    method("pressure-acoustics", "1.1.0", "initializations", "acoustics.spectrum", "Exactly one spectrum is required by harmonic analysis; prohibited for transient analysis.")
    method("pressure-acoustics", "1.1.0", "initializations", "acoustics.time", "Transient clock: explicit fixed dt and integer totalSteps; windowSteps defaults to totalSteps. Time starts at zero; every window uses the same time grid. dt must satisfy the documented CFL condition.")
    parameter("pressure-acoustics", "1.1.0", "dt", "Fixed acoustic step in seconds, independent of window size.", scalar("Time", "s", minimum=0, exclusiveMinimum=True), method=("initializations", "acoustics.time"))
    for key, description, optional in [("totalSteps", "Total number of acoustic steps.", False), ("windowSteps", "Steps per invocation; omitted uses totalSteps; final invocation takes only remaining whole steps.", True)]:
        parameter("pressure-acoustics", "1.1.0", key, description, {"dtype": "int32", "tensorOrder": 0, "minimum": 1}, method=("initializations", "acoustics.time"), optional=optional)
    method("pressure-acoustics", "1.1.0", "boundaryConditions", "acoustics.tone-burst-velocity", "Uniform fluid-outward normal velocity: amplitude * sin(2*pi*frequency*(t-startTime)) * sin(pi*(t-startTime)/duration)^2 within [startTime,startTime+duration], zero outside. Acoustic steps integrate the waveform, including its finite support.", kind="surface", target_count=1, max_targets=2147483647, maximum=2147483647)
    for key, description, data in [
        ("amplitude", "Signed fluid-outward velocity amplitude; negative at the left end drives a +X traveling wave.", scalar("kinematics.Speed", "m.s-1")),
        ("frequency", "Carrier frequency; this finite burst is not an ideal impulse.", scalar("Frequency", "Hz", minimum=0, exclusiveMinimum=True)),
        ("startTime", "Burst start on the common run time origin.", scalar("Time", "s", minimum=0)),
        ("duration", "Finite Hann-window support duration.", scalar("Time", "s", minimum=0, exclusiveMinimum=True)),
    ]:
        parameter("pressure-acoustics", "1.1.0", key, description, data, method=("boundaryConditions", "acoustics.tone-burst-velocity"))
    motion_data = {"resourceKind": "structuredBundle", "visualization": {"kind": "bundle"}, "members": {
        "times": {**scalar("Time", "s"), "axes": [{"name": "time"}]},
        "velocity": {"dtype": "float64", "quantityKind": "kinematics.Velocity", "unit": "m.s-1", "tensorOrder": 1,
                     "axes": [{"name": "node"}, {"name": "time"}], "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
    }}
    artifact = "caemble.mechanics/transient-surface-motion@1"
    method("structural-mechanics", "6.1.0", "exports", "fea.transient-surface-motion", "Actual current-window translational velocities on the exterior reference tri3 surface, global Cartesian m/s. Initial calls export one initial frame; trial/convergence metadata is explicit. Independent of RecordedData Boxes and outputInterval; never the next-window fea.motion prediction.", kind="surface", target_count=1, max_targets=2147483647, maximum=2147483647, artifact=artifact, data=motion_data)
    command("solver", "input-port", "upsert", "pressure-acoustics", "1.1.0", "transientSurfaceMotion", "--description",
            "One converged actual structural surface interval on the common run clock; rejects initial frames, predictions, trial samples, gaps, overlaps and extrapolation. Reference tri3 mesh and real global velocity are self-contained.",
            "--minimum-occurrences", 0, "--maximum-occurrences", 1, "--artifact-type", artifact, "--data-json", json.dumps(motion_data))
    method("pressure-acoustics", "1.1.0", "boundaryConditions", "acoustics.transient-surface-motion", "Planar interface driven by transientSurfaceMotion. Source P1 velocity is integrated over each grid boundary face and each acoustic time step; complete nonmatching coverage is required.", kind="surface", target_count=1, max_targets=2147483647)
    pressure = {
        "dtype": "float64", "quantityKind": "acoustics.SoundPressure", "unit": "Pa",
        "axes": [
            *[{"name": axis, "quantityKind": "Length", "unit": "m"} for axis in ("x", "y", "z")],
            {"name": "time", "quantityKind": "Time", "unit": "s"},
            {"name": "frequency", "quantityKind": "Frequency", "unit": "Hz", "length": 1, "ticks": [0]},
            {"name": "amplitudePhase", "length": 1, "ticks": ["value"]},
            {"name": "component", "length": 1, "ticks": ["pressure"]},
        ],
        "boxGrid": {"version": 1, "sampling": "point", "components": ["pressure"], "channels": ["value"], "channelUnits": ["Pa"]},
        "visualization": {"kind": "box-grid"},
    }
    method("pressure-acoustics", "1.1.0", "outputs", "acoustics.pressure-history", "Signed pressure sampled at Box cell centers. Cumulative t=0 and global step multiples of sampleEvery only, without duplicate window endpoints. Last recorded time can precede checkpoint time. Coarse samples have no anti-alias filtering; all values outside the exact fluid Box are zero.", source="either", target_count=1, maximum=2147483647, artifact="caemble.box-grid/pressure-acoustics/acoustics.pressure-history@1", data=pressure)
    parameter("pressure-acoustics", "1.1.0", "gridShape", "Positive Box Grid cell counts [nx,ny,nz].", {"dtype": "int32", "minimum": 1, "axes": [{"length": 3}]}, method=("outputs", "acoustics.pressure-history"))
    parameter("pressure-acoustics", "1.1.0", "sampleEvery", "Positive integer stride on the run's fixed acoustic time grid; default 1 preserves every pressure step.", {"dtype": "int32", "tensorOrder": 0, "minimum": 1}, method=("outputs", "acoustics.pressure-history"), optional=True)
    for key, description in {
        "time": "Current pressure/checkpoint time in seconds.", "stepCount": "Current global acoustic step number.",
        "totalSteps": "Configured total number of acoustic steps.", "cellCount": "Number of pressure cells.",
        "timeStep": "Fixed acoustic time increment in seconds.",
        "discreteEnergy": "Staggered modified discrete energy in joules at the documented half-step; not a simultaneous p/v square sum.",
    }.items():
        command("solver", "observation", "upsert", "pressure-acoustics", "1.1.0", key, "--description", description, "--type", "number")


def update_existing_examples():
    with open_catalog(DRAFT) as catalog:
        entries, _ = catalog.list_experiments(limit=100)
        affected = [catalog.experiment(entry["coordinate"]) for entry in entries if any(s["name"] in {"structural-mechanics", "pressure-acoustics"} for s in entry["relatedSolvers"])]
    for example in affected:
        old = example["coordinate"]
        major, minor, patch = map(int, example["version"].split("."))
        example["version"] = f"{major}.{minor + 1}.0"
        for solver in example["relatedSolvers"]:
            if solver["name"] in {"structural-mechanics", "pressure-acoustics"}:
                previous = solver["version"]
                solver["version"] = "6.1.0" if solver["name"] == "structural-mechanics" else "1.1.0"
                for filename, source in example["sourceBundle"]["files"].items():
                    source = source.replace(f"name: '{solver['name']}', version: '{previous}'", f"name: '{solver['name']}', version: '{solver['version']}'")
                    source = source.replace(f"name: \"{solver['name']}\", version: \"{previous}\"", f"name: \"{solver['name']}\", version: \"{solver['version']}\"")
                    example["sourceBundle"]["files"][filename] = source
        publish_example(example, old=old)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1] == "contracts":
        update_contracts()
        update_existing_examples()
    elif sys.argv[1] == "publish":
        command("solver", "remove", "structural-mechanics", "6.0.0")
        command("solver", "remove", "pressure-acoustics", "1.0.0")
        command("publish", "--destination", CANONICAL)
    print(f"Completed {sys.argv[1]}: {DRAFT}")
