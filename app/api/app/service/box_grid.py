"""The persisted numerical result boundary accepts only Box Grid tensors."""
import math

GEOMETRY_FIELDS = {"origin", "size", "rotation", "lengthUnit", "gridShape", "source", "rootId"}


def validate_result_provenance(provenance: dict) -> None:
    if not isinstance(provenance, dict) or any(not isinstance(provenance.get(key), str) or not provenance[key] for key in ("task", "catalogRevision")):
        raise ValueError("Result provenance requires its Task and Catalog revision.")
    solver = provenance.get("solver")
    if not isinstance(solver, dict) or set(solver) != {"name", "version"} or any(not isinstance(value, str) or not value for value in solver.values()):
        raise ValueError("Result provenance requires its Solver name and version.")
    if type(provenance.get("stateRevision")) is not int or provenance["stateRevision"] < 0 or type(provenance.get("invocation")) is not int or provenance["invocation"] < 1:
        raise ValueError("Result provenance requires a nonnegative state revision and positive invocation.")


def validate_box_grid_schema(schema: dict) -> None:
    if not isinstance(schema, dict) or schema.get("dtype") not in {"float32", "float64"}:
        raise ValueError("Outputs require a real-valued Box Grid Tensor schema.")
    axes, grid = schema.get("axes"), schema.get("boxGrid")
    if not isinstance(axes, list) or len(axes) != 7 or not all(isinstance(axis, dict) for axis in axes):
        raise ValueError("Box Grid Tensor schemas require exactly seven axes.")
    if [axis.get("name") for axis in axes] != ["x", "y", "z", "time", "frequency", "amplitudePhase", "component"]:
        raise ValueError("Box Grid axes must be x, y, z, time, frequency, amplitudePhase, component.")
    if not isinstance(grid, dict) or grid.get("version") != 1 or GEOMETRY_FIELDS.intersection(grid) or "geometry" in grid:
        raise ValueError("Box Grid schema version 1 is required; candidate geometry belongs to the tensor.")
    if grid.get("sampling") not in {"point", "cell-average", "aggregate"}:
        raise ValueError("Unsupported Box Grid sampling convention.")
    components, channels, units = grid.get("components"), grid.get("channels"), grid.get("channelUnits")
    if not isinstance(components, list) or not components or any(not isinstance(item, str) or not item for item in components) or len(set(components)) != len(components):
        raise ValueError("Box Grid components require distinct nonempty labels.")
    if channels not in (["value"], ["amplitude", "phase"]):
        raise ValueError("Box Grid channels must be value or amplitude/phase.")
    if not isinstance(units, list) or len(units) != len(channels) or any(not isinstance(unit, str) or not unit for unit in units):
        raise ValueError("Every Box Grid channel requires a unit.")
    if len(channels) == 2 and units[1] != "rad":
        raise ValueError("Box Grid phase is measured in radians.")
    if grid.get("frequencyKind") not in {None, "modal", "sampled"}:
        raise ValueError("Unsupported Box Grid frequency kind.")
    for index, axis in enumerate(axes):
        length = axis.get("length")
        if length is not None and (type(length) is not int or length < 1):
            raise ValueError("Box Grid axes must have positive integer lengths.")
        expected = len(channels) if index == 5 else len(components) if index == 6 else None
        if expected is not None and length != expected:
            raise ValueError("Box Grid channel/component axes differ from their labels.")


def validate_box_grid_tensor(schema: dict, tensor: dict) -> None:
    validate_box_grid_schema(schema)
    if not isinstance(tensor, dict):
        raise ValueError("Recorded output must be a Box Grid Tensor.")
    shape, grid = tensor.get("shape"), tensor.get("boxGrid")
    if not isinstance(shape, list) or len(shape) != 7 or any(type(size) is not int or size < 1 for size in shape):
        raise ValueError("Recorded Box Grid Tensor shape requires seven positive dimensions.")
    for index, axis in enumerate(schema["axes"]):
        if axis.get("length") is not None and axis["length"] != shape[index]:
            raise ValueError("Recorded Box Grid shape differs from the output schema.")
    if not isinstance(grid, dict) or {key: value for key, value in grid.items() if key not in GEOMETRY_FIELDS} != schema["boxGrid"]:
        raise ValueError("Recorded Box Grid metadata differs from the output schema.")
    geometry = grid
    if geometry.get("gridShape") != shape[:3]:
        raise ValueError("Recorded Box Grid requires geometry with its spatial grid shape.")
    if geometry.get("source") not in {"experiment", "task"} or not isinstance(geometry.get("rootId"), str) or not geometry["rootId"]:
        raise ValueError("Recorded Box Grid requires its geometry source and root ID.")
    if not isinstance(geometry.get("lengthUnit"), str) or not geometry["lengthUnit"]:
        raise ValueError("Recorded Box Grid geometry requires a length unit.")
    for key in ("origin", "size"):
        values = geometry.get(key)
        if not isinstance(values, list) or len(values) != 3 or any(type(value) not in {int, float} or not math.isfinite(value) or (key == "size" and value <= 0) for value in values):
            raise ValueError("Recorded Box Grid geometry requires finite origin and positive size.")
    rotation = geometry.get("rotation")
    if not isinstance(rotation, list) or len(rotation) != 3 or any(not isinstance(row, list) or len(row) != 3 for row in rotation):
        raise ValueError("Recorded Box Grid rotation requires a 3 by 3 matrix.")
    if any(type(value) not in {int, float} or not math.isfinite(value) for row in rotation for value in row):
        raise ValueError("Recorded Box Grid rotation must be finite.")
    if any(abs(sum(a * b for a, b in zip(row, other)) - (i == j)) > 1e-8 for i, row in enumerate(rotation) for j, other in enumerate(rotation)):
        raise ValueError("Recorded Box Grid rotation must be orthonormal.")
    if grid["sampling"] == "aggregate" and shape[:3] != [1, 1, 1]:
        raise ValueError("Aggregate Outputs require gridShape [1, 1, 1].")
    validate_result_provenance(tensor.get("provenance"))
