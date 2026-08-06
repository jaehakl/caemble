import base64
import binascii
import json
import math
import struct
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel as PydanticBaseModel
from pydantic import ConfigDict, EmailStr, Field, field_serializer, field_validator, model_validator

from quantity_kind_catalog import QUANTITY_KIND_APPLICABLE_UNITS, QUANTITY_KIND_TENSOR_ORDERS
from utils.datetime_utils import serialize_datetime_utc


class BaseModel(PydanticBaseModel):
    @field_serializer("*", when_used="json")
    def serialize_datetimes(self, value: Any) -> Any:
        return serialize_datetime_utc(value)


class RoleEnum(str, Enum):
    admin = "admin"
    user = "user"


class UserData(BaseModel):
    id: str
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    picture_url: Optional[str] = None
    is_active: Optional[bool] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    roles: List[RoleEnum]


class GetListRequestBase(BaseModel):
    scope: Literal["visible", "mine", "public"] = "visible"
    offset: Optional[int] = 0
    limit: Optional[int] = None
    selected_ids: Optional[List[int]] = None
    search_text: Optional[str] = None
    text_filter: Optional[Dict[str, List[str]]] = None
    filter: Optional[Dict[str, List[Any]]] = None
    sort: Optional[List[str]] = None
    random: Optional[bool] = False


class GetListResponseBase(BaseModel):
    total: int
    items: List[Any]


class UpsertResponseBase(BaseModel):
    id: int
    fk_not_found: Optional[Dict[str, List[int]]] = None


class TimestampFields(BaseModel):
    id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OwnedTimestampFields(TimestampFields):
    user_id: Optional[str] = None


class MaterialBase(OwnedTimestampFields):
    inchi: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: Optional[str]) -> Optional[str]:
        return value.lower() if value is not None else None


class MaterialNameBase(OwnedTimestampFields):
    material_id: int
    name: str = Field(..., min_length=1)


class MaterialParameterBase(OwnedTimestampFields):
    material_id: int
    name: str = Field(..., min_length=1)
    value: Any
    source: Optional[str] = None
    version: Optional[str] = None
    description: Optional[str] = None
    temperature: Optional[float] = None
    pressure: Optional[float] = None
    frequency: Optional[float] = None


class MaterialParameterQualifierBase(TimestampFields):
    material_parameter_id: int
    name: str = Field(..., min_length=1)
    value: float


class CodeEntityBase(OwnedTimestampFields):
    parent_id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    code: str = Field(..., min_length=1)


class GeometryBase(CodeEntityBase):
    pass


class StructureBase(CodeEntityBase):
    pass


class ExperimentBase(CodeEntityBase):
    simulation_code: Optional[str] = None


class SaveCodeEntityRequest(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    code: str = Field(..., min_length=1)
    rawCodeHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHashVersion: Literal[1]
    baseRawCodeHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    baseSemanticHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class SaveExperimentRequest(SaveCodeEntityRequest):
    simulationCode: str = Field(..., min_length=1)
    simulationRawCodeHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    baseSimulationRawCodeHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class SaveCodeEntityResponse(BaseModel):
    id: int
    action: Literal["created", "updated", "forked"]
    parentId: Optional[int] = None


class SampleBase(OwnedTimestampFields):
    structure_id: int
    vars: Dict[str, Any] = Field(default_factory=dict)
    material_parameters: Dict[str, Any] = Field(default_factory=dict)


class SetupBase(OwnedTimestampFields):
    experiment_id: int
    vars: Dict[str, Any] = Field(default_factory=dict)
    material_parameters: Dict[str, Any] = Field(default_factory=dict)


class MeasurementBase(OwnedTimestampFields):
    sample_id: int
    setup_id: int


class MeasurementContextListRequest(BaseModel):
    structure_id: int
    experiment_id: int


class RecordedDataSchemaAxis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    length: Optional[int] = Field(default=None, gt=0)
    name: Optional[str] = Field(default=None, min_length=1)
    ticks: Optional[List[Any]] = None
    unit: Optional[str] = Field(default=None, min_length=1)
    quantityKind: Optional[str] = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_quantity_metadata(self):
        if self.ticks is not None:
            if self.length is not None and len(self.ticks) != self.length:
                raise ValueError("DataSchema axis ticks must match length.")
            if any(
                isinstance(tick, bool)
                or not isinstance(tick, (int, float, str))
                or (isinstance(tick, float) and not math.isfinite(tick))
                for tick in self.ticks
            ):
                raise ValueError("DataSchema axis ticks must be finite numbers or strings.")
        if (self.unit is None) != (self.quantityKind is None):
            raise ValueError("DataSchema axis must specify both unit and quantityKind or neither.")
        if self.quantityKind is None:
            return self
        tensor_order = QUANTITY_KIND_TENSOR_ORDERS.get(self.quantityKind)
        if tensor_order is None:
            raise ValueError(f"unknown QuantityKind: {self.quantityKind!r}.")
        if tensor_order != 0:
            raise ValueError("DataSchema axis quantityKind must be scalar.")
        if self.unit not in QUANTITY_KIND_APPLICABLE_UNITS[self.quantityKind]:
            raise ValueError(
                f"DataSchema axis unit {self.unit!r} is not applicable to QuantityKind {self.quantityKind!r}."
            )
        return self


class RecordedDataSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dtype: Literal[
        "bool",
        "string",
        "int8",
        "int16",
        "int32",
        "int64",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "float16",
        "float32",
        "float64",
    ]
    unit: Optional[str] = Field(default=None, min_length=1)
    quantityKind: Optional[str] = Field(default=None, min_length=1)
    basis: Optional[List[List[float]]] = None
    axes: Optional[List[RecordedDataSchemaAxis]] = None

    @field_validator("basis", mode="before")
    @classmethod
    def validate_basis_numbers(cls, value: Any) -> Any:
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or any(
                not isinstance(axis, list)
                or any(isinstance(component, bool) or not isinstance(component, (int, float)) for component in axis)
                for axis in value
            )
        ):
            raise ValueError("basis must contain numeric Cartesian basis vectors.")
        return value

    @model_validator(mode="after")
    def validate_schema(self):
        is_float = self.dtype.startswith("float")
        if is_float and (self.unit is None or self.quantityKind is None):
            raise ValueError("float DataSchema must specify both unit and quantityKind.")
        if not is_float and any(value is not None for value in (self.unit, self.quantityKind, self.basis)):
            raise ValueError("unit, quantityKind, and basis are allowed only for float DataSchema.")
        if self.axes is not None and not self.axes:
            raise ValueError("DataSchema axes must be omitted instead of empty.")
        if self.quantityKind is None:
            return self

        tensor_order = QUANTITY_KIND_TENSOR_ORDERS.get(self.quantityKind)
        if tensor_order is None:
            raise ValueError(f"unknown QuantityKind: {self.quantityKind!r}.")
        if self.unit not in QUANTITY_KIND_APPLICABLE_UNITS[self.quantityKind]:
            raise ValueError(
                f"DataSchema unit {self.unit!r} is not applicable to QuantityKind {self.quantityKind!r}."
            )
        if tensor_order == 0 and self.basis is not None:
            raise ValueError("basis is not allowed for a scalar QuantityKind.")
        if tensor_order > 0 and self.basis is None:
            raise ValueError("basis is required for a tensor QuantityKind.")
        if self.basis is None:
            return self
        if len(self.basis) != 3 or any(len(axis) != 3 for axis in self.basis):
            raise ValueError("basis must contain exactly three Cartesian basis vectors.")
        if any(not math.isfinite(component) for axis in self.basis for component in axis):
            raise ValueError("basis must contain finite numbers.")
        tolerance = 1e-9
        for left in range(3):
            for right in range(left, 3):
                dot = sum(self.basis[left][index] * self.basis[right][index] for index in range(3))
                if abs(dot - (1 if left == right else 0)) > tolerance:
                    raise ValueError("basis must be orthonormal.")
        determinant = (
            self.basis[0][0] * (self.basis[1][1] * self.basis[2][2] - self.basis[1][2] * self.basis[2][1])
            - self.basis[0][1] * (self.basis[1][0] * self.basis[2][2] - self.basis[1][2] * self.basis[2][0])
            + self.basis[0][2] * (self.basis[1][0] * self.basis[2][1] - self.basis[1][1] * self.basis[2][0])
        )
        if abs(determinant - 1) > tolerance:
            raise ValueError("basis must be right-handed.")
        return self

    def tensor_order(self) -> int:
        return 0 if self.quantityKind is None else QUANTITY_KIND_TENSOR_ORDERS[self.quantityKind]


class MeasurementSaveRecordedData(BaseModel):
    name: str = Field(..., min_length=1)
    quantity_kind: Optional[str] = Field(default=None, min_length=1)
    tensor_order: int = Field(..., ge=0)
    dtype: str = Field(..., min_length=1)
    data_schema: RecordedDataSchema
    data: Any = None

    @model_validator(mode="after")
    def validate_compatibility_columns(self):
        if self.dtype != self.data_schema.dtype:
            raise ValueError("dtype must match data_schema.dtype.")
        if self.quantity_kind != self.data_schema.quantityKind:
            raise ValueError("quantity_kind must match data_schema.quantityKind.")
        if self.tensor_order != self.data_schema.tensor_order():
            raise ValueError("tensor_order must match the QuantityKind catalog.")
        return self


MAX_RECORDED_DATA_BYTES = 64 * 1024 * 1024
DATA_TENSOR_INLINE_BYTES = 64 * 1024
_DTYPE_WIDTHS = {
    "bool": 1,
    "int8": 1,
    "int16": 2,
    "int32": 4,
    "int64": 8,
    "uint8": 1,
    "uint16": 2,
    "uint32": 4,
    "uint64": 8,
    "float16": 2,
    "float32": 4,
    "float64": 8,
}


def _validate_inline_tensor(value: Any, shape: list[int], dtype: str, path: str, depth: int = 0) -> None:
    if depth < len(shape):
        if not isinstance(value, list) or len(value) != shape[depth]:
            raise ValueError(f"{path} must have shape {shape}.")
        for index, item in enumerate(value):
            _validate_inline_tensor(item, shape, dtype, f"{path}[{index}]", depth + 1)
        return
    if isinstance(value, list):
        raise ValueError(f"{path} has an extra tensor dimension.")
    if dtype == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{path} must be bool.")
        return
    if dtype == "string":
        if not isinstance(value, str):
            raise ValueError(f"{path} must be string.")
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{path} must be a finite {dtype} value.")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError(f"{path} must be a finite {dtype} value.")
    if dtype.startswith(("int", "uint")):
        bits = int(dtype.removeprefix("uint").removeprefix("int"))
        minimum = 0 if dtype.startswith("uint") else -(2 ** (bits - 1))
        maximum = 2**bits - 1 if dtype.startswith("uint") else 2 ** (bits - 1) - 1
        if not isinstance(value, int) or not -(2**53 - 1) <= value <= 2**53 - 1 or not minimum <= value <= maximum:
            raise ValueError(f"{path} must be a range-safe {dtype} integer.")
    if dtype == "float16" and abs(value) > 65504:
        raise ValueError(f"{path} is outside the finite float16 range.")
    if dtype == "float32":
        try:
            if not math.isfinite(struct.unpack("<f", struct.pack("<f", value))[0]):
                raise ValueError(f"{path} is outside the finite float32 range.")
        except OverflowError as error:
            raise ValueError(f"{path} is outside the finite float32 range.") from error


def _validate_persisted_tensor(item: MeasurementSaveRecordedData, index: int) -> int:
    path = f"recorded_data[{index}].data"
    tensor = item.data
    schema = item.data_schema
    if (
        not isinstance(tensor, dict)
        or isinstance(tensor.get("tensorEncodingVersion"), bool)
        or tensor.get("tensorEncodingVersion") != 1
    ):
        raise ValueError(f"{path} must use tensorEncodingVersion 1.")
    allowed = {"tensorEncodingVersion", "shape", "axes", "storage"}
    if set(tensor) - allowed:
        raise ValueError(f"{path} contains unsupported fields.")
    shape = tensor.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) > 32
        or any(
            isinstance(length, bool)
            or not isinstance(length, int)
            or length < 0
            or length > 2**53 - 1
            for length in shape
        )
    ):
        raise ValueError(f"{path}.shape must contain at most 32 non-negative integers.")
    tensor_order = schema.tensor_order()
    schema_axes = schema.axes or []
    outer_rank = len(schema_axes)
    if len(shape) != outer_rank + tensor_order:
        raise ValueError(
            f"{path}.shape rank must match {outer_rank} DataSchema axes plus tensor order {tensor_order}."
        )
    for axis_index, axis in enumerate(schema_axes):
        if axis.length is not None and shape[axis_index] != axis.length:
            raise ValueError(
                f"{path}.shape[{axis_index}] must match data_schema.axes[{axis_index}].length."
            )
    if tensor_order > 0 and shape[-tensor_order:] != [3] * tensor_order:
        raise ValueError(f"{path}.shape does not match QuantityKind tensor order {tensor_order}.")

    axes = tensor.get("axes")
    if axes is None:
        if any(axis.length is None for axis in schema_axes):
            raise ValueError(f"{path}.axes is required for a dynamic DataSchema axis.")
    else:
        if not isinstance(axes, list) or len(axes) != outer_rank:
            raise ValueError(f"{path}.axes must contain {outer_rank} axes.")
        for axis_index, axis in enumerate(axes):
            if not isinstance(axis, dict) or set(axis) - {"ticks"}:
                raise ValueError(f"{path}.axes[{axis_index}] may contain ticks only.")
            ticks = axis.get("ticks")
            schema_axis = schema_axes[axis_index]
            if schema_axis.length is None and ticks is None:
                raise ValueError(f"{path}.axes[{axis_index}].ticks is required for a dynamic DataSchema axis.")
            if ticks is not None and (
                not isinstance(ticks, list)
                or len(ticks) != shape[axis_index]
                or any(
                    isinstance(tick, bool)
                    or not isinstance(tick, (int, float, str))
                    or (isinstance(tick, float) and not math.isfinite(tick))
                    for tick in ticks
                )
            ):
                raise ValueError(f"{path}.axes[{axis_index}].ticks must match the actual axis length.")
            if schema_axis.ticks is not None and ticks != schema_axis.ticks:
                raise ValueError(f"{path}.axes[{axis_index}].ticks must match data_schema.")

    storage = tensor.get("storage")
    if not isinstance(storage, dict) or storage.get("kind") not in {"inline", "base64"}:
        raise ValueError(f"{path}.storage must be inline or base64.")
    element_count = math.prod(shape)
    if storage["kind"] == "inline":
        if set(storage) != {"kind", "value"}:
            raise ValueError(f"{path}.storage inline fields are invalid.")
        _validate_inline_tensor(storage["value"], shape, schema.dtype, f"{path}.storage.value")
        raw_length = (
            len(json.dumps(storage["value"], ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if schema.dtype == "string"
            else element_count * _DTYPE_WIDTHS[schema.dtype]
        )
        if raw_length > DATA_TENSOR_INLINE_BYTES:
            raise ValueError(f"{path}.storage inline data exceeds 64 KiB.")
        return raw_length

    if set(storage) != {"kind", "data", "byteLength"}:
        raise ValueError(f"{path}.storage base64 fields are invalid.")
    declared = storage["byteLength"]
    if isinstance(declared, bool) or not isinstance(declared, int) or not 0 <= declared <= MAX_RECORDED_DATA_BYTES:
        raise ValueError(f"{path}.storage.byteLength is invalid.")
    if not isinstance(storage["data"], str) or len(storage["data"]) > 4 * ((declared + 2) // 3):
        raise ValueError(f"{path}.storage.data is larger than declared.")
    try:
        raw = base64.b64decode(storage["data"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"{path}.storage.data must be valid base64.") from error
    if len(raw) != declared:
        raise ValueError(f"{path}.storage.byteLength does not match decoded data.")
    if schema.dtype == "string":
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"{path}.storage string data must be UTF-8 JSON.") from error
        _validate_inline_tensor(decoded, shape, schema.dtype, f"{path}.storage")
        return declared
    expected = element_count * _DTYPE_WIDTHS[schema.dtype]
    if declared != expected:
        raise ValueError(f"{path}.storage must contain product(shape) x dtype-width bytes.")
    if schema.dtype == "bool" and any(value not in (0, 1) for value in raw):
        raise ValueError(f"{path}.storage bool bytes must be 0 or 1.")
    if schema.dtype in {"float16", "float32", "float64"}:
        code = {"float16": "e", "float32": "f", "float64": "d"}[schema.dtype]
        if any(not math.isfinite(value[0]) for value in struct.iter_unpack(f"<{code}", raw)):
            raise ValueError(f"{path}.storage contains non-finite values.")
    if schema.dtype in {"int64", "uint64"}:
        code = "q" if schema.dtype == "int64" else "Q"
        if any(abs(value[0]) > 2**53 - 1 for value in struct.iter_unpack(f"<{code}", raw)):
            raise ValueError(f"{path}.storage contains integers outside the safe range.")
    return declared


class MeasurementSaveRequest(BaseModel):
    sample_id: int
    setup_id: int
    recorded_data: List[MeasurementSaveRecordedData] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_recorded_data_tensors(self):
        total = sum(_validate_persisted_tensor(item, index) for index, item in enumerate(self.recorded_data))
        if total > MAX_RECORDED_DATA_BYTES:
            raise ValueError(
                f"recorded_data contains {total} raw bytes; maximum per Measurement Run is {MAX_RECORDED_DATA_BYTES}."
            )
        return self


class MeasurementSaveResponse(BaseModel):
    id: int


class RecordedDataBase(OwnedTimestampFields):
    measurement_id: int
    name: str = Field(..., min_length=1)
    quantity_kind: Optional[str] = Field(default=None, min_length=1)
    tensor_order: int = Field(..., ge=0)
    dtype: str = Field(..., min_length=1)
    data_schema: Optional[RecordedDataSchema] = None
    data: Any = None
    data_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)

    @field_serializer("data_schema")
    def serialize_data_schema(self, value: Optional[RecordedDataSchema]) -> Optional[Dict[str, Any]]:
        return None if value is None else value.model_dump(exclude_none=True)

    @model_validator(mode="after")
    def validate_versioned_tensor(self):
        if self.data_schema is None:
            return self
        item = MeasurementSaveRecordedData(
            name=self.name,
            quantity_kind=self.quantity_kind,
            tensor_order=self.tensor_order,
            dtype=self.dtype,
            data_schema=self.data_schema,
            data=self.data,
        )
        if self.data is not None:
            _validate_persisted_tensor(item, 0)
        return self


class ModelArtifactBase(OwnedTimestampFields):
    structure_id: int
    experiment_id: int
    model_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)


class DesignerModelBase(ModelArtifactBase):
    pass


class PredictorModelBase(ModelArtifactBase):
    pass
