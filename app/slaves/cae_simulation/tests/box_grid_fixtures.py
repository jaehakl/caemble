"""Small reusable fixtures, independent of pytest test modules."""

from app.methods.fields.box_grid import BoxGrid
import numpy as np


def grid(shape=(2, 2, 2), origin=(0, 0, 0), size=(1, 1, 1), rotation=None):
    return BoxGrid({"origin": list(origin), "size": list(size),
                    "rotation": np.eye(3).tolist() if rotation is None else rotation,
                    "lengthUnit": "m", "gridShape": list(shape), "source": "task", "rootId": "probe"})


def data(components=("scalar",), polar=False, sampling="point"):
    channels = ["amplitude", "phase"] if polar else ["value"]
    return {"dtype": "float64", "tensorOrder": 0, "axes": [{}] * 7,
            "boxGrid": {"version": 1, "sampling": sampling, "components": list(components),
                        "channels": channels, "channelUnits": ["1", "rad"] if polar else ["1"]}}
