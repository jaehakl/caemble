import json
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from calculation_contract import extract_contract, contract_hash, assert_tensor_contract


def test_declaration_is_static_and_canonical():
    declaration = {"version": 1, "inputs": {}, "output": {"dtype": "float64", "shape": []}}
    source = "/* @caemble-contract " + json.dumps(declaration) + " */\nthrow 'never execute'"
    assert extract_contract(source) == declaration
    assert extract_contract("old code") is None
    assert contract_hash(declaration) == contract_hash(dict(reversed(list(declaration.items()))))
    with pytest.raises(ValueError):
        extract_contract(source + "/* @caemble-contract {} */")
    with pytest.raises(ValueError):
        extract_contract("code;" + source)


def test_tensor_contract_shapes_units_bounds():
    declaration = {"dtype": "float64", "shape": [None, 2], "axes": [{"unit": "m"}, {}], "min": 0}
    tensor = {"dtype": "float64", "shape": [1, 2], "axes": [{"name": "x", "unit": "m"}, {}], "data": [1, 2]}
    assert_tensor_contract(declaration, tensor, values=True)
    for change in [{"shape": [1, 3]}, {"dtype": "float32"}, {"data": [-1, 2]}, {"axes": [{"unit": "K"}, {}]}]:
        with pytest.raises(ValueError):
            assert_tensor_contract(declaration, {**tensor, **change}, values=True)


@pytest.mark.parametrize("output", [
    {"dtype": "float64", "shape": [True]}, {"dtype": "float64", "shape": [-1]},
    {"dtype": "float64", "shape": [], "axes": [{}]}, {"dtype": "float64", "shape": [], "min": 2, "max": 1},
    {"dtype": "float64", "shape": [], "ticks": []},
])
def test_invalid_declaration(output):
    with pytest.raises(ValueError):
        extract_contract("/* @caemble-contract " + json.dumps({"version": 1, "inputs": {}, "output": output}) + " */")


def test_stored_tensor_bounds_and_scope(monkeypatch):
    import asyncio
    import hashlib
    from io import BytesIO
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from service.calculation_contract import validate_stored_tensor
    from storage.service import reference

    payload = b'[1,2]'
    digest = hashlib.sha256(payload).hexdigest()
    row = SimpleNamespace(id='test-object', experiment_id=7, ready=True, deleting=False,
        manifest={"encoding": "json", "sha256": digest, "byteLength": len(payload), "length": 2,
                  "chunks": [{"sha256": digest, "byteLength": len(payload)}]})
    db = SimpleNamespace(get=AsyncMock(return_value=row))
    monkeypatch.setattr('service.calculation_contract.bucket_client',
        lambda: SimpleNamespace(get_object=lambda **kwargs: {"Body": BytesIO(payload)}))
    tensor = {"dtype": "float64", "shape": [2], "data": reference(row)}
    contract = {"dtype": "float64", "shape": [None], "min": 0, "max": 2}
    asyncio.run(validate_stored_tensor(db, contract, tensor, experiment_id=7))
    with pytest.raises(ValueError, match='bounds'):
        asyncio.run(validate_stored_tensor(db, {**contract, "max": 1}, tensor, experiment_id=7))
    with pytest.raises(ValueError, match='unavailable'):
        asyncio.run(validate_stored_tensor(db, contract, tensor, experiment_id=8))
    row.manifest['chunks'][0]['sha256'] = '0' * 64
    with pytest.raises(ValueError, match='checksum'):
        asyncio.run(validate_stored_tensor(db, contract, tensor, experiment_id=7))
