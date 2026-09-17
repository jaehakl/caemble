"""Small reusable fixtures, independent of pytest test modules."""

from app.kernel.coordinator.plan import RunPlan, TaskSpec, detached
from dataclasses import replace
from typing import Any


class FakeRun:
    def __init__(self) -> None:
        self.run_id = "coordinator-test"
        self.max_run_seconds = 10
        self.trace: list[dict[str, Any]] = []
        self.progress_values: list[Any] = []
        output_specs = {
            "producer": {"field": {
                "artifactType": "test/field@1",
                "data": {"dtype": "float64", "axes": [{"name": "x"}]},
            }},
            "consumer": {"answer": {
                "artifactType": "test/scalar@1", "data": {"dtype": "float64"},
            }},
        }
        descriptors = {
            "producer": {"inputPorts": {}},
            "consumer": {"inputPorts": {"field": {
                "artifactTypes": ["test/field@1"], "minimumOccurrences": 1, "maximumOccurrences": 1,
            }}},
        }
        specs = {
            name: TaskSpec(
                name=name, task={"kernel": {"name": name, "version": "1.0.0"}, "config": {}},
                descriptor=descriptors[name], locator=f"unused:{name}", abi_version=3,
                output_specs=output_specs[name], scene={}, material_snapshot={},
            )
            for name in ("producer", "consumer")
        }
        self.plan = RunPlan(specs, {}, {}, {
            "field": {"dtype": "float64", "axes": [{"name": "x"}]},
            "field-series": {
                "field": {"dtype": "float32", "axes": [{"name": "time"}, {"name": "x"}, {"name": "y"}]},
                "time": {"dtype": "float32", "axes": [{"name": "time"}]},
            },
        })
        self.plan = replace(self.plan, result_contracts={
            name: {"task": "producer", "output": "field", "solver": {"name": "producer", "version": "1.0.0"},
                   "artifactType": "test/field-series@1" if name == "field-series" else "test/field@1"}
            for name in self.plan.schemas
        })
        self.recorded: tuple[str, Any] | None = None
        self.on_record = None

    @property
    def producer(self):
        return self.plan.tasks["producer"]

    @property
    def consumer(self):
        return self.plan.tasks["consumer"]

    def configure_task(self, name, *, outputs=None, inputs=None, abi_version=3):
        spec = self.plan.task_specs[name]
        output_specs = detached(spec.output_specs)
        descriptor = detached(spec.descriptor)
        for key, value in (outputs or {}).items():
            output_specs[key].update(value)
        for key, value in (inputs or {}).items():
            descriptor["inputPorts"][key].update(value)
        specs = dict(self.plan.task_specs)
        specs[name] = replace(spec, abi_version=abi_version, output_specs=output_specs, descriptor=descriptor)
        self.plan = replace(self.plan, task_specs=specs)

    async def progress(self, value: Any) -> None:
        self.progress_values.append(value)

    async def record(self, name: str, value: Any, *, resource_hold: Any = None) -> None:
        if self.on_record is not None:
            self.on_record()
        self.recorded = (name, value)
        if resource_hold is not None:
            resource_hold.hand_off()
            resource_hold.release()
