from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

import numpy as np

from app.errors import CaeError
from app.runtime_kernel.catalog import solver_catalog
from app.runtime_kernel.catalog.normalization import normalize_task_config


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
    material_parameters: Mapping[str, Any]
    material_warnings: tuple[Any, ...] = ()
    artifact_payload_kinds: Mapping[str, str | None] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in (
            "task", "descriptor", "output_specs", "scene",
            "material_parameters", "material_warnings", "artifact_payload_kinds",
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
    material_parameters: Mapping[str, Any]
    material_warnings: tuple[Any, ...]
    schemas: Mapping[str, Any]
    tasks: TaskHandles = field(init=False)

    def __post_init__(self) -> None:
        for name in ("task_specs", "scene", "material_parameters", "material_warnings", "schemas"):
            object.__setattr__(self, name, read_only(getattr(self, name)))
        object.__setattr__(self, "tasks", TaskHandles(self.task_specs))

    @classmethod
    def prepare(
        cls,
        measurement: Mapping[str, Any],
        tasks: Mapping[str, Any],
        schemas: Mapping[str, Any],
    ) -> RunPlan:
        specs = {}
        for name, task in tasks.items():
            kernel = task["kernel"]
            descriptor = solver_catalog.descriptor(kernel["name"], kernel["version"])
            config, outputs = normalize_task_config(descriptor, task["config"], name)
            abi_version = solver_catalog.abi_version(kernel["name"], kernel["version"])
            artifact_payload_kinds = {}
            if abi_version >= 2:
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
                material_parameters=measurement["taskMaterialParameters"][name],
                material_warnings=measurement["taskMaterialWarnings"][name],
                artifact_payload_kinds=artifact_payload_kinds,
            )
        return cls(
            task_specs=specs,
            scene=measurement["experiment"]["scene"],
            material_parameters=measurement["materialParameters"],
            material_warnings=measurement["materialWarnings"],
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
                "experiment": {"parameters": self.material_parameters, "warnings": self.material_warnings},
                "task": {"parameters": task.material_parameters, "warnings": task.material_warnings},
            },
        })
