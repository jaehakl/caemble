import json
import struct

import numpy as np

from app.kernel.transport.tensor import decode_attachment_tensors, encode_tensor


def test_complex64_inline_and_attachment_encoding():
    schema = {"dtype": "complex64"}
    values = np.asarray([[3 + 4j, -2 - 5j]], dtype=np.complex64)
    tensor, attachments, size = encode_tensor("field", schema, {"value": values, "axes": [{"ticks": [0]}, {"ticks": [1, 2], "bounds": [0, 3]}]}, 1)
    assert size == 16 and attachments == [] and tensor["shape"] == [1, 2]
    assert json.loads(json.dumps(tensor))["storage"]["value"] == [[{"re": 3, "im": 4}, {"re": -2, "im": -5}]]
    assert tensor["axes"][1]["bounds"] == [0, 3]
    large = np.tile(values, (5000, 1))
    tensor, attachments, size = encode_tensor("field", schema, large, 2)
    assert tensor["shape"] == [5000, 2] and size == large.size * 8
    assert attachments[0].data[:16] == struct.pack("<ffff", 3, 4, -2, -5)
    decoded = decode_attachment_tensors({"dtype": "complex64", "value": tensor}, attachments)
    np.testing.assert_array_equal(decoded["value"], large)
