from __future__ import annotations

import copy
import hashlib
import json


def dataset(values=(0, 1, 2)):
    grid = {"version": 1, "sampling": "point", "components": ["scalar"], "channels": ["value"],
            "channelUnits": ["K"], "origin": [0, 0, 0], "size": [2, 4, 6], "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            "gridShape": [1, 1, 1], "lengthUnit": "m", "source": "task", "rootId": "box"}
    ticks = [[1], [2], [3], [0], [0], ["value"], ["scalar"]]
    axes = [{"name": name, "ticks": tick, **({"unit": unit} if unit else {})} for name, tick, unit in
            zip(("x", "y", "z", "time", "frequency", "amplitudePhase", "component"), ticks, ("m", "m", "m", "s", "Hz", None, None))]
    schema = {"dtype": "float64", "unit": "K", "quantityKind": "thermodynamics.Temperature", "axes": axes, "boxGrid": grid}
    records = [{"id": 10, "name": "heat.T", "contract_hash": "heat-contract"}]
    measurements = [{"id": index + 1, "vars": {"x": value}} for index, value in enumerate(values)]
    recorded = []
    for index, value in enumerate(10 + 10 * value for value in values):
        cell = value
        for _ in range(7):
            cell = [cell]
        own_grid = {**grid, "origin": [index * 10, 0, 0], "size": [2 + index, 4, 6]}
        recorded.append({"id": 20 + index, "name": "heat.T", "measurement_id": index + 1,
                         "experiment_record_id": 10, "dtype": "float64", "data_schema": copy.deepcopy(schema),
                         "data": {"shape": [1] * 7, "boxGrid": own_grid, "axes": [{"ticks": tick} for tick in ticks],
                                  "storage": {"kind": "inline", "value": cell}}})
    result = {"kind": "caemble.prediction.dataset", "version": 1, "datasetId": "dataset-1", "revision": 1,
              "name": "Heat fixture", "experimentId": 1, "sourceHash": "experiment-source",
              "varsSchema": {"x": {"shape": [], "min": 0, "max": 2}}, "measurements": measurements,
              "records": records, "recorded": recorded, "rules": [{"label": "heat.T", "target": [], "methodId": "fixture", "parameters": {}, "result": schema}],
              "resultContracts": {"heat": {"task": "heat-task"}},
              "calculations": [{"id": 4, "name": "Maximum", "source_code": "maximum", "source_hash": "calculation-source",
                                "output_layout": {"dtype": "float64", "shape": [], "axes": []}, "experiment_record_ids": [10]}],
              "calculationData": [{"id": 30 + index, "calculation_id": 4, "measurement_id": index + 1,
                                   "data": {"dtype": "float64", "shape": [], "axes": [], "data": 10 + 10 * value}} for index, value in enumerate(values)]}
    result["fingerprint"] = "sha256:" + hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def definition(manifest, **algorithm):
    return {"fingerprint": "model-fingerprint", "snapshotFingerprint": manifest["fingerprint"],
            "implementationId": "remote-knn", "implementationVersion": "knn-v1", "preprocessingVersion": "box-relative-v2",
            "algorithm": {"kind": "knn", "kMode": "auto", "manualK": 1, "weighting": "distance", **algorithm}}


def stage(runtime, manifest=None):
    manifest = manifest or dataset()
    metadata = {key: manifest[key] for key in ("datasetId", "revision", "fingerprint", "experimentId", "name")}
    metadata.update(runtime.reader.summary(manifest, "local"))
    runtime.store.write("datasets", manifest["datasetId"], manifest["revision"], metadata,
                        lambda path: (path / "dataset.json").write_text(json.dumps(manifest), encoding="utf-8"))
    runtime.store.publish_dataset(manifest["datasetId"], manifest["revision"])
    return {key: manifest[key] for key in ("datasetId", "revision", "fingerprint")}
