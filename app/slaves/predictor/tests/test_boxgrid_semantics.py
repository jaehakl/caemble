"""Small physical output regressions for the relative BoxGrid preprocessing policy."""
import copy
import math

import pytest

from predictor.knn import KnnModel
from .fixtures import dataset
from .test_prediction import call, prepare, runtime


def polar_dataset(*, modal=False, multiple=False):
    manifest = dataset()
    manifest["measurements"] = manifest["measurements"][:2]
    manifest["recorded"] = manifest["recorded"][:2]
    for row in manifest["recorded"]:
        row["data"]["boxGrid"] = copy.deepcopy(row["data"]["boxGrid"])
        row["data"]["boxGrid"].update(channels=["amplitude", "phase"], channelUnits=["K", "rad"])
        if modal:
            row["data"]["boxGrid"]["frequencyKind"] = "modal"
        row["data"]["shape"][5] = 2
        row["data"]["axes"][5]["ticks"] = ["amplitude", "phase"]
        row["data"]["axes"][4]["ticks"] = [100 + row["measurement_id"] * 10] if modal else [100]
        phase = math.pi - .1 if row["measurement_id"] == 1 else -math.pi + .1
        row["data"]["storage"]["value"] = [[[[[[[1], [phase]]]]]]]
    manifest["rules"][0]["result"]["boxGrid"].update(channels=["amplitude", "phase"], channelUnits=["K", "rad"])
    if modal:
        manifest["rules"][0]["result"]["boxGrid"]["frequencyKind"] = "modal"
    if multiple:
        manifest["records"].append({"id": 11, "name": "heat.other", "contract_hash": "other"})
        manifest["rules"].append({**copy.deepcopy(manifest["rules"][0]), "label": "heat.other"})
        for index, row in enumerate(list(manifest["recorded"])):
            other = copy.deepcopy(row)
            other.update(id=40 + index, name="heat.other", experiment_record_id=11)
            other["data"]["storage"]["value"] = [[[[[[[10 + index * 10], [0]]]]]]]
            manifest["recorded"].append(other)
    return manifest


def test_polar_values_average_cartesian_components_across_phase_wrap(tmp_path):
    worker = runtime(tmp_path)
    model = prepare(worker, manifest=polar_dataset(), kMode="manual", manualK=2)
    result = call(worker, "model.predict", instance=model["instance"], input={"direction": "forward", "vars": {"x": .5}})
    assert result["output"][0]["values"] == pytest.approx([-math.cos(.1), 0], abs=1e-12)


def test_modal_outputs_and_frequency_ticks_share_one_nearest_measurement(tmp_path):
    worker = runtime(tmp_path)
    model = prepare(worker, manifest=polar_dataset(modal=True, multiple=True))
    result = call(worker, "model.predict", instance=model["instance"], input={"direction": "forward", "vars": {"x": .6}})
    assert result["knn"]["neighbors"] == [{"measurementId": 2, "distanceSquared": pytest.approx(.04), "weight": 1}]
    assert result["output"][0]["values"] == pytest.approx([-math.cos(.1), -math.sin(.1), 120])
    assert result["output"][1]["values"] == pytest.approx([20, 0, 120])


def test_modal_group_excludes_measurement_missing_one_coupled_output(tmp_path):
    manifest = polar_dataset(modal=True, multiple=True)
    manifest["recorded"] = [row for row in manifest["recorded"] if not (row["measurement_id"] == 2 and row["experiment_record_id"] == 11)]
    worker = runtime(tmp_path)
    model = prepare(worker, manifest=manifest)
    result = call(worker, "model.predict", instance=model["instance"], input={"direction": "forward", "vars": {"x": .9}})
    assert model["profile"]["includedMeasurementIds"] == [1]
    assert [row["values"][-1] for row in result["output"]] == [110, 110]


def test_pixel_power_excludes_different_pixel_counts_and_source_frequencies():
    def pixels(value, count=2, frequency=5e14):
        return {"layout": {"key": "detectorPower", "dtype": "float64", "shape": [count, 1, 1, 1, 1, 1, 1],
            "quantityKind": "optics.RadiantFlux", "unit": "W", "tensorOrder": 0,
            "axes": [{"name": name, "ticks": ticks, **({"unit": unit} if unit else {})} for name, ticks, unit in
                zip(["x", "y", "z", "time", "frequency", "amplitudePhase", "component"],
                    [[(index + .5) * 2 / count for index in range(count)], [.5], [.1], [0], [frequency], ["value"], ["value"]],
                    ["m", "m", "m", "s", "Hz", None, None])],
            "boxGrid": {"version": 1, "sampling": "surface-integral", "frequencyKind": "source-sampled",
                "components": ["value"], "channels": ["value"], "channelUnits": ["W"], "origin": [0, 0, -.1],
                "size": [2, 1, .2], "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "lengthUnit": "m",
                "gridShape": [count, 1, 1], "source": "experiment", "rootId": "sensor"}}, "values": [value] * count}
    variable = lambda value: {"layout": {"key": "spacing", "dtype": "float64", "shape": [], "minimum": 0, "maximum": 2}, "values": [value]}
    rows = [{"measurementId": index + 1, "inputs": [variable(value)], "outputs": [output]} for index, (value, output) in
            enumerate([(0, pixels(1)), (2, pixels(3)), (1, pixels(5, 3)), (1, pixels(7, frequency=6e14))])]
    model = KnnModel.build(rows, fingerprint="pixel-power", input_keys=["spacing"], output_keys=["detectorPower"],
        algorithm={"kMode": "manual", "manualK": 2, "weighting": "distance"}, memory_budget=1000000)
    assert model.metadata["cohort"]["includedMeasurementIds"] == [1, 2]
    assert model.metadata["cohort"]["excluded"]["layout-mismatch"] == 2
    result = model.predict([variable(1)])
    assert result["output"][0]["values"] == [2, 2]
    assert result["output"][0]["layout"]["boxGrid"]["sampling"] == "surface-integral"
