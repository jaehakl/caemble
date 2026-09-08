from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

import numpy as np
from caemble_catalog.model_schema import validate_parameter_schema

from app.kernel.api.errors import CaeError
from app.kernel.catalog import solver_catalog
from app.kernel.catalog.normalization import normalize_task_config
from app.kernel.catalog.materials import normalize_material_snapshot, select_material_models


def read_only(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        frozen = np.array(value, copy=True, subok=True)
        frozen.setflags(write=False)
        return frozen
    if isinstance(value, Mapping):
        return MappingProxyType({key: read_only(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(read_only(item) for item in value)
    return value


def detached(value: Any) -> Any:
    """Convert the prepared snapshot into an invocation's serializable tree."""
    if isinstance(value, np.ndarray):
        return np.array(value, copy=True, subok=True)
    if isinstance(value, Mapping):
        return {key: detached(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [detached(item) for item in value]
    return value


@dataclass(frozen=True, slots=True)
class TaskSpec:
    name: str
    task: Mapping[str, Any]
    descriptor: Mapping[str, Any]
    locator: str
    abi_version: int
    output_specs: Mapping[str, Any]
    scene: Mapping[str, Any]
    material_snapshot: Mapping[str, Any]
    material_selections: Mapping[str, Any] = field(default_factory=dict)
    artifact_payload_kinds: Mapping[str, str | None] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in (
            "task", "descriptor", "output_specs", "scene",
            "material_snapshot", "material_selections", "artifact_payload_kinds",
        ):
            object.__setattr__(self, name, read_only(getattr(self, name)))


class TaskHandles(Mapping[str, Mapping[str, Any]]):
    def __init__(self, specs: Mapping[str, TaskSpec]) -> None:
        self._tasks = MappingProxyType({name: spec.task for name, spec in specs.items()})

    def __getitem__(self, name: str) -> Mapping[str, Any]:
        if not isinstance(name, str):
            raise CaeError(
                "invalid_input",
                f"simulate.py tasks[{name!r}] requires a declared Task name string",
            )
        try:
            return self._tasks[name]
        except KeyError:
            raise CaeError("invalid_input", f"simulate.py tasks[{name!r}] is not declared") from None

    def __iter__(self) -> Iterator[str]:
        return iter(self._tasks)

    def __len__(self) -> int:
        return len(self._tasks)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tasks


@dataclass(frozen=True, slots=True)
class RunPlan:
    task_specs: Mapping[str, TaskSpec]
    scene: Mapping[str, Any]
    material_snapshot: Mapping[str, Any]
    schemas: Mapping[str, Any]
    tasks: TaskHandles = field(init=False)

    def __post_init__(self) -> None:
        for name in ("task_specs", "scene", "material_snapshot", "schemas"):
            object.__setattr__(self, name, read_only(getattr(self, name)))
        object.__setattr__(self, "tasks", TaskHandles(self.task_specs))

    @classmethod
    def prepare(
        cls,
        measurement: Mapping[str, Any],
        tasks: Mapping[str, Any],
        schemas: Mapping[str, Any],
    ) -> RunPlan:
        if not isinstance(measurement.get("modelDefinitions"), list):
            raise CaeError("invalid_material", "modelDefinitions must be an array")
        definitions = {}
        for index, definition in enumerate(measurement["modelDefinitions"]):
            path = f"modelDefinitions[{index}]"
            required = {"key", "labelKo", "description", "equation", "conventions", "parameterSchema"}
            if not isinstance(definition, Mapping) or not required <= set(definition) or set(definition) - required - {"solverRequirements"}:
                raise CaeError("invalid_material", f"{path} must contain a complete Model definition")
            if any(not isinstance(definition[field], str) for field in required - {"parameterSchema"}):
                raise CaeError("invalid_material", f"{path} requires string model identification and description fields")
            if "solverRequirements" in definition and not isinstance(definition["solverRequirements"], list):
                raise CaeError("invalid_material", f"{path}.solverRequirements must be an array")
            key = definition["key"]
            if key in definitions:
                raise CaeError("invalid_material", f"{path}.key duplicates Model definition {key!r}")
            try:
                validate_parameter_schema(definition["parameterSchema"], f"{path}.parameterSchema")
            except (ValueError, TypeError, OverflowError, RecursionError) as error:
                raise CaeError("invalid_material", str(error)) from error
            canonical = solver_catalog.material_model(key)
            if {field: definition.get(field) for field in canonical} != canonical:
                raise CaeError("invalid_material", f"Model definition {key!r} does not match its registered version")
            definitions[key] = definition
        for field_name in ("taskMaterialSnapshots", "materialSelections"):
            if not isinstance(measurement.get(field_name), Mapping) or set(measurement[field_name]) != set(tasks):
                raise CaeError("invalid_material", f"{field_name} must identify every Task exactly once")
        experiment_materials = normalize_material_snapshot(measurement.get("materialSnapshot"), definitions, "experiment.materials")
        known_materials = dict(experiment_materials)
        specs = {}
        for name, task in tasks.items():
            kernel = task["kernel"]
            descriptor = solver_catalog.descriptor(kernel["name"], kernel["version"])
            config, outputs = normalize_task_config(descriptor, task["config"])
            abi_version = solver_catalog.abi_version(kernel["name"], kernel["version"])
            if abi_version != 3:
                raise CaeError("unsupported_solver_abi", f"task {name} requires Solver ABI 3")
            task_materials = normalize_material_snapshot(
                measurement["taskMaterialSnapshots"][name], definitions, f"tasks.{name}.materials",
            )
            for material_name, material in task_materials.items():
                if material_name in known_materials and known_materials[material_name] != material:
                    raise CaeError("invalid_material", f"Material {material_name!r} has conflicting definitions in this Experiment")
                known_materials[material_name] = material
            selections = select_material_models(
                descriptor, config,
                {"experiment": measurement["experiment"]["scene"], "task": measurement["experiment"]["taskScenes"][name]},
                {"experiment": experiment_materials, "task": task_materials},
                measurement["materialSelections"][name],
            )
            artifact_types = {output["artifactType"] for output in outputs.values()}
            artifact_types.update(
                artifact_type for port in descriptor["inputPorts"].values()
                for artifact_type in port["artifactTypes"]
            )
            artifact_payload_kinds = {
                artifact_type: solver_catalog.artifact_type(artifact_type).get("payloadKind")
                for artifact_type in artifact_types
            }
            specs[name] = TaskSpec(
                name=name,
                task={"kernel": kernel, "config": config},
                descriptor=descriptor,
                locator=solver_catalog.locator(kernel["name"], kernel["version"]),
                abi_version=abi_version,
                output_specs=outputs,
                scene=measurement["experiment"]["taskScenes"][name],
                material_snapshot=task_materials,
                material_selections=selections,
                artifact_payload_kinds=artifact_payload_kinds,
            )
        used_definitions = {model["model"] for material in known_materials.values() for model in material["models"].values()}
        if set(definitions) != used_definitions:
            raise CaeError("invalid_material", "modelDefinitions must capture exactly the models present in Material snapshots")
        return cls(
            task_specs=specs,
            scene=measurement["experiment"]["scene"],
            material_snapshot=experiment_materials,
            schemas=schemas,
        )

    def resolve(self, task: Mapping[str, Any]) -> TaskSpec:
        for spec in self.task_specs.values():
            if spec.task is task:
                return spec
        raise CaeError(
            "invalid_input", "sim.run only accepts a task registered by this BuiltMeasurement"
        )

    def world(self, task: TaskSpec) -> dict[str, Any]:
        return detached({
            "experiment": self.scene,
            "task": task.scene,
            "materials": {
                "experiment": self.material_snapshot,
                "task": task.material_snapshot,
            },
            "materialSelections": task.material_selections,
        })
