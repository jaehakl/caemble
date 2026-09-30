from typing import Any, Dict, Optional

from pydantic import BaseModel


class ExperimentSourceBundle(BaseModel):
    files: Dict[str, str]


class ExperimentRecordContract(BaseModel):
    name: str
    quantity_kind: Optional[str] = None
    tensor_order: int
    dtype: str
    data_schema: Optional[Dict[str, Any]] = None
