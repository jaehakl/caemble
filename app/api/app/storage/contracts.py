from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt


class ObjectReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["caemble.object"]
    version: Literal[1]
    id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    encoding: Literal["json", "base64"]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byteLength: StrictInt = Field(gt=0)
    length: StrictInt | None = Field(default=None, ge=0)


def reference_length(value):
    if isinstance(value, dict):
        ref = ObjectReference.model_validate(value)
        if ref.encoding != "json" or ref.length is None:
            raise ValueError("Array references require JSON encoding and a length.")
        return ref.length
    return len(value)
