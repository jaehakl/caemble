"""PyTorch Forward MLP with portable, inert weights and one complete output cohort.

Torch is imported only when constructing an execution model. Artifact inspection,
backup and restore use JSON and pickle-free NumPy arrays alone.
"""
from __future__ import annotations

import copy
import math
from pathlib import Path

import numpy as np

from .errors import PredictionError
from .execution import ModelExecutionContext
from .knn import cohort
from .representations import recorded_sample, value_count, vars_layouts, vars_samples
from .storage import check_cancel, encode_json


def execution_device(context: ModelExecutionContext):
    import torch
    from sdk.slave.execution import configure_torch

    configure_torch(torch)
    allocation = context.allocation
    if allocation is None or not allocation.gpu_devices:
        return torch, torch.device("cpu")
    if len(allocation.gpu_devices) != 1 or not torch.cuda.is_available():
        raise PredictionError("resource-allocation", "MLP requires its allocated CUDA device; CPU fallback is disabled.")
    budget = allocation.vram_budget_bytes[allocation.gpu_devices[0]]
    try:
        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1.0, budget / total), 0)
    except RuntimeError as error:
        raise PredictionError("resource-allocation", "The allocated CUDA device could not be initialized.") from error
    return torch, torch.device("cuda:0")


def memory_requirements(sizes: list[int], count: int, batch: int) -> dict:
    parameters = sum((left + 1) * right for left, right in zip(sizes, sizes[1:])) * 4
    normalization = 8 * (sizes[0] * 3 + sizes[-1] * 2)
    # Weights, gradients, Adam moments, optimizer temporaries and activations.
    activation = 4 * batch * (sum(sizes) * 6 + sizes[-1] * 4)
    return {"parameters": parameters, "persistent": parameters + normalization,
            "inference": activation + parameters,
            "training": parameters * 8 + activation,
            "hostTraining": count * (sizes[0] + sizes[-1]) * 40 + parameters * 10 + normalization + activation}


def check_memory(context: ModelExecutionContext, host: int, device: int, torch=None) -> None:
    check_cancel(context.cancel)
    if host > context.available_ram_bytes:
        raise PredictionError("memory-limit", f"MLP requires approximately {host} host bytes; {context.available_ram_bytes} available.")
    if context.allocation is not None and context.allocation.gpu_devices:
        budget = context.allocation.vram_budget_bytes[context.allocation.gpu_devices[0]]
        retained = torch.cuda.memory_allocated(0) if torch is not None else 0
        # CUDA libraries also need workspace; the allocator cap enforces actual use.
        if retained + device + 64 * 1024**2 > budget:
            raise PredictionError("memory-limit", "MLP weights, optimizer and working arrays exceed the allocated VRAM budget.")


def make_network(torch, sizes: list[int]):
    layers = []
    for index, (left, right) in enumerate(zip(sizes, sizes[1:])):
        layers.append(torch.nn.Linear(left, right))
        if index < len(sizes) - 2:
            layers.append(torch.nn.Tanh())
    return torch.nn.Sequential(*layers)


def release_cuda_cache(torch) -> None:
    # Pinned Torch 2.13 retains cuBLAS workspaces outside empty_cache(). The
    # documented workspace hook releases them after all queued kernels finish.
    torch.cuda.synchronize()
    torch._C._cuda_clearCublasWorkspaces()
    torch.cuda.empty_cache()


class TorchMlpForwardModel:
    def __init__(self, metadata: dict, numerical: dict, arrays: dict, network, torch, device):
        self.metadata, self.numerical, self.arrays = metadata, numerical, arrays
        self.network, self.torch, self.device = network, torch, device
        self.input_layouts, self.output_layouts = numerical["inputLayouts"], numerical["outputLayouts"]
        self.persistent_bytes = sum(array.nbytes for array in arrays.values())
        if device.type == "cpu":
            self.persistent_bytes += sum(parameter.numel() * parameter.element_size() for parameter in network.parameters())

    @classmethod
    def prepare(cls, dataset: dict, definition: dict, model_ref: dict,
                context: ModelExecutionContext) -> "TorchMlpForwardModel":
        from prediction_contracts import validate_mlp_algorithm

        algorithm = validate_mlp_algorithm(definition["algorithm"])
        selected_ids = definition.get("requiredRecordIds", [record["id"] for record in dataset["records"]])
        by_id = {record["id"]: record for record in dataset["records"]}
        if not selected_ids or len(set(selected_ids)) != len(selected_ids) or any(identity not in by_id for identity in selected_ids):
            raise PredictionError("missing-contract", "Select one or more BoxGrid outputs present in the Dataset revision.")
        records = [by_id[identity] for identity in selected_ids]
        by_name = {rule["label"]: rule for rule in dataset["rules"]}
        rules = []
        for record in records:
            rule = by_name.get(record["name"], {})
            result, grid = rule.get("result", {}), rule.get("result", {}).get("boxGrid", {})
            if not grid or result.get("dtype") not in ("float32", "float64") or grid.get("channels") != ["value"] or grid.get("frequencyKind") == "modal":
                raise PredictionError("unsupported-representation", "MLP supports real-valued, non-modal BoxGrid outputs only.")
            rules.append(rule)
        layouts = vars_layouts(dataset["varsSchema"])
        stored = {(row["measurement_id"], row["experiment_record_id"]): row for row in dataset.get("recorded", [])}
        rows = []
        for measurement in sorted(dataset["measurements"], key=lambda row: row["id"]):
            check_cancel(context.cancel)
            try:
                inputs = vars_samples(measurement["vars"], dataset["varsSchema"])
                outputs = [recorded_sample(stored[(measurement["id"], record["id"])]) for record in records
                           if (measurement["id"], record["id"]) in stored]
                for sample in outputs:
                    if sample["layout"]["boxGrid"]["channels"] != ["value"] or sample["layout"].get("frequencyOutput"):
                        raise PredictionError("unsupported-representation", "MLP cannot train complex or modal samples.")
                rows.append({"measurementId": measurement["id"], "inputs": inputs, "outputs": outputs})
            except (PredictionError, KeyError, TypeError, ValueError, IndexError) as error:
                if isinstance(error, PredictionError) and error.code in ("cancelled", "unsupported-representation"):
                    raise
                rows.append({"measurementId": measurement["id"], "inputs": [], "outputs": [], "error": str(error)})
        selected, summary = cohort(rows, [layout["key"] for layout in layouts], [record["name"] for record in records], layouts, cancel=context.cancel)
        output_layouts = [sample["layout"] for sample in selected[0]["outputs"]]
        input_offsets, output_offsets = [0], [0]
        for layout in layouts:
            input_offsets.append(input_offsets[-1] + value_count(layout))
        for layout in output_layouts:
            output_offsets.append(output_offsets[-1] + value_count(layout))
        sizes = [input_offsets[-1], *algorithm["hiddenLayers"], output_offsets[-1]]
        if sizes[0] < 1 or sizes[-1] < 1:
            raise PredictionError("invalid-data", "MLP input and output must contain numeric cells.")
        batch = min(algorithm["batchSize"], len(selected))
        resources = memory_requirements(sizes, len(selected), batch)
        check_memory(context, resources["hostTraining"], resources["training"])
        inputs = np.asarray([[value for sample in row["inputs"] for value in sample["values"]] for row in selected], dtype=np.float64)
        outputs = np.asarray([[value for sample in row["outputs"] for value in sample["values"]] for row in selected], dtype=np.float64)
        minimums = np.concatenate([np.full(value_count(layout), layout["minimum"]) for layout in layouts]).astype(np.float64)
        maximums = np.concatenate([np.full(value_count(layout), layout["maximum"]) for layout in layouts]).astype(np.float64)
        magnitudes = np.maximum(1.0, np.maximum(np.abs(minimums), np.abs(maximums)))
        output_magnitude = np.maximum(1.0, np.abs(outputs).max(axis=0))
        center = (outputs / output_magnitude).mean(axis=0) * output_magnitude
        # Explicit constants retain their original float64 value exactly.
        constant = np.all(outputs == outputs[0], axis=0)
        center[constant] = outputs[0, constant]
        scale = (outputs / output_magnitude).std(axis=0) * output_magnitude
        scale[constant] = 0
        arrays = {"inputMinimums": minimums, "inputMaximums": maximums, "inputMagnitudes": magnitudes,
                  "outputCenter": center, "outputScale": scale}
        normalized_input = cls.normalize_inputs(inputs, arrays)
        with np.errstate(over="ignore", invalid="ignore"):
            normalized_output = np.divide(outputs - center, scale, out=np.zeros_like(outputs), where=scale != 0).astype(np.float32)
        if not np.isfinite(normalized_output).all():
            raise PredictionError("invalid-data", "MLP output normalization exceeds the finite numeric range.")
        torch, device = execution_device(context)
        check_memory(context, resources["hostTraining"], resources["training"], torch)
        network = optimizer = x = y = prediction = loss = active = None
        try:
            # Restore process RNG state and keep shuffling on a private CPU generator.
            with torch.random.fork_rng(devices=[]):
                torch.random.default_generator.manual_seed(algorithm["seed"])
                network = make_network(torch, sizes).to(device)
            generator = torch.Generator(device="cpu").manual_seed(algorithm["seed"])
            active = torch.from_numpy(~constant).to(device)
            optimizer = torch.optim.Adam(network.parameters(), lr=algorithm["learningRate"], foreach=False) if not constant.all() else None
            losses = [] if optimizer is not None else [0.0]
            network.train()
            for epoch in range(algorithm["epochs"] if optimizer is not None else 0):
                order = torch.randperm(len(selected), generator=generator).numpy()
                total_loss = 0.0
                for start in range(0, len(selected), batch):
                    check_cancel(context.cancel)
                    indices = order[start:start + batch]
                    x = torch.from_numpy(normalized_input[indices]).to(device)
                    y = torch.from_numpy(normalized_output[indices]).to(device)
                    optimizer.zero_grad(set_to_none=True)
                    prediction = network(x)
                    loss = torch.nn.functional.mse_loss(prediction[:, active], y[:, active])
                    if not torch.isfinite(loss):
                        raise PredictionError("invalid-data", "MLP training produced a nonfinite loss.")
                    loss.backward()
                    if any(not torch.isfinite(parameter.grad).all() for parameter in network.parameters() if parameter.grad is not None):
                        raise PredictionError("invalid-data", "MLP training produced nonfinite gradients.")
                    optimizer.step()
                    total_loss += float(loss.detach().cpu()) * len(indices)
                    check_cancel(context.cancel)
                losses.append(total_loss / len(selected))
                if context.progress is not None and (epoch == 0 or (epoch + 1) % max(1, algorithm["epochs"] // 100) == 0):
                    context.progress({"stage": "training", "fraction": (epoch + 1) / algorithm["epochs"],
                                      "metrics": {"epoch": epoch + 1, "loss": losses[-1]}})
            check_cancel(context.cancel)
            if optimizer is None and context.progress is not None:
                context.progress({"stage": "training", "fraction": 1.0, "metrics": {"epoch": 0, "loss": 0.0}})
            network.eval()
            network.zero_grad(set_to_none=True)
            for index, layer in enumerate(network[::2]):
                arrays[f"weight-{index}"] = layer.weight.detach().cpu().numpy().copy()
                arrays[f"bias-{index}"] = layer.bias.detach().cpu().numpy().copy()
            layer = None
            if any(not np.isfinite(array).all() for array in arrays.values()):
                raise PredictionError("invalid-data", "MLP training produced nonfinite weights.")
            numerical = {"inputLayouts": layouts, "outputLayouts": output_layouts, "inputOffsets": input_offsets,
                         "outputOffsets": output_offsets, "sizes": sizes, "algorithm": algorithm,
                         "cohort": summary, "loss": losses[-1], "initialLoss": losses[0]}
            metadata = {**model_ref, "formatVersion": 1, "direction": "forward", "algorithm": "mlp", "definition": copy.deepcopy(definition),
                        "datasetId": dataset["datasetId"], "datasetRevision": dataset["revision"], "datasetFingerprint": dataset["fingerprint"],
                        "experimentId": dataset["experimentId"], "sourceHash": dataset.get("sourceHash"), "varsSchema": dataset["varsSchema"],
                        "resultContracts": dataset.get("resultContracts", {}), "records": records, "rules": rules}
            return cls(metadata, numerical, arrays, network, torch, device)
        except BaseException as error:
            network = None
            if isinstance(error, torch.OutOfMemoryError):
                raise PredictionError("memory-limit", "MLP exceeded its allocated memory during training.") from error
            raise
        finally:
            optimizer = x = y = prediction = loss = active = None
            if device.type == "cuda":
                release_cuda_cache(torch)

    @staticmethod
    def normalize_inputs(values: np.ndarray, arrays: dict) -> np.ndarray:
        low, high, magnitude = (arrays[key] for key in ("inputMinimums", "inputMaximums", "inputMagnitudes"))
        width = high / magnitude - low / magnitude
        with np.errstate(over="ignore", invalid="ignore"):
            result = np.divide(values / magnitude - low / magnitude, width,
                               out=np.full_like(values, .5), where=width != 0) * 2 - 1
            result = result.astype(np.float32)
        if not np.isfinite(result).all():
            raise PredictionError("invalid-data", "MLP input normalization exceeds the finite numeric range.")
        return result

    def profile(self) -> dict:
        summary, sizes = self.numerical["cohort"], self.numerical["sizes"]
        resource = memory_requirements(sizes, summary["includedRows"], 1)
        return {"direction": "forward", "rowCount": summary["includedRows"], "inputLayouts": self.input_layouts,
                "inputSize": sizes[0], "outputSize": sizes[-1],
                **{key: copy.deepcopy(summary[key]) for key in ("includedMeasurementIds", "warningMeasurementIds", "diagnostics", "omittedDiagnosticGroups", "excluded")},
                "resources": {"persistentBytes": self.persistent_bytes, "workingSetBytes": self.persistent_bytes + resource["inference"]},
                "mlp": {**self.numerical["algorithm"], "activation": "tanh", "optimizer": "adam", "inputScaling": "range",
                        "loss": self.numerical["loss"], "initialLoss": self.numerical["initialLoss"]}}

    def preparation_details(self) -> dict:
        return {"errors": {}, "rules": self.metadata["rules"], "recordProfiles": [
            {"recordId": record["id"], "name": record["name"], "error": None, "profile": self.profile()}
            for record in self.metadata["records"]]}

    def predict(self, values: dict, context: ModelExecutionContext) -> dict:
        return self.predict_many([values], context)[0]

    def predict_many(self, values: list[dict], context: ModelExecutionContext) -> list[dict]:
        if self.network is None:
            raise PredictionError("instance-invalidated", "MLP is already released.")
        if not values:
            return []
        resources = memory_requirements(self.numerical["sizes"], 0, len(values))
        check_memory(context, resources["inference"] * 4, resources["inference"], self.torch)
        queries = np.asarray([[value for sample in vars_samples(row, self.metadata["varsSchema"]) for value in sample["values"]]
                              for row in values], dtype=np.float64)
        normalized = self.normalize_inputs(queries, self.arrays)
        try:
            with self.torch.inference_mode():
                raw = self.network(self.torch.from_numpy(normalized).to(self.device)).cpu().numpy().astype(np.float64)
        except self.torch.OutOfMemoryError as error:
            if self.device.type == "cuda":
                release_cuda_cache(self.torch)
            raise PredictionError("memory-limit", "MLP inference exceeded its allocated memory.") from error
        check_cancel(context.cancel)
        result = raw * self.arrays["outputScale"] + self.arrays["outputCenter"]
        results = []
        for query, predicted in zip(queries, result):
            output, extrapolated, changed = [], [], []
            for index, layout in enumerate(self.output_layouts):
                cells = predicted[slice(*self.numerical["outputOffsets"][index:index + 2])]
                with np.errstate(over="ignore", invalid="ignore"):
                    cells = cells.astype(layout["dtype"]).astype(np.float64)
                if not np.isfinite(cells).all():
                    raise PredictionError("invalid-data", "MLP prediction is outside its finite output dtype range.")
                output.append({"layout": copy.deepcopy(layout), "values": cells.tolist()})
            for index, layout in enumerate(self.input_layouts):
                cells = query[slice(*self.numerical["inputOffsets"][index:index + 2])]
                if np.any(cells < layout["minimum"]) or np.any(cells > layout["maximum"]):
                    extrapolated.append(layout["key"])
                    if layout["minimum"] == layout["maximum"]:
                        changed.append(layout["key"])
            results.append({"direction": "forward", "fingerprint": self.metadata["definition"]["fingerprint"], "output": output,
                            "extrapolatedInputKeys": extrapolated, "constantInputKeysChanged": changed, "queryDiagnostics": []})
        return results

    def close(self) -> None:
        self.network = None
        self.arrays.clear()
        self.persistent_bytes = 0
        if self.device.type == "cuda":
            release_cuda_cache(self.torch)

    def write(self, path: Path, cancel=None) -> None:
        check_cancel(cancel)
        (path / "model.json").write_bytes(encode_json({"metadata": self.metadata, "numerical": self.numerical}))
        for name, array in self.arrays.items():
            check_cancel(cancel)
            with (path / f"{name}.npy").open("wb") as stream:
                np.save(stream, array, allow_pickle=False)

    @staticmethod
    def validate_artifact(path: Path, manifest: dict, content: dict) -> set[str]:
        from prediction_contracts import validate_mlp_algorithm

        try:
            metadata, numerical = content["metadata"], content["numerical"]
            algorithm = validate_mlp_algorithm(metadata["definition"]["algorithm"])
            if metadata["formatVersion"] != 1 or metadata["algorithm"] != "mlp" or numerical["algorithm"] != algorithm:
                raise ValueError("Unsupported MLP artifact metadata.")
            if numerical["inputLayouts"] != vars_layouts(metadata["varsSchema"]):
                raise ValueError("MLP input layout differs from its Vars schema.")
            sizes = [sum(value_count(layout) for layout in numerical["inputLayouts"]), *algorithm["hiddenLayers"],
                     sum(value_count(layout) for layout in numerical["outputLayouts"])]
            if numerical["sizes"] != sizes or sizes[0] < 1 or sizes[-1] < 1:
                raise ValueError("MLP network dimensions differ from its layouts.")
            for side in ("input", "output"):
                offsets = [0]
                for layout in numerical[f"{side}Layouts"]:
                    offsets.append(offsets[-1] + value_count(layout))
                    if side == "output" and (layout.get("dtype") not in ("float32", "float64") or layout.get("boxGrid", {}).get("channels") != ["value"] or layout.get("boxGrid", {}).get("frequencyKind") == "modal" or layout.get("frequencyOutput")):
                        raise ValueError("MLP output must be a real non-modal BoxGrid.")
                if numerical[f"{side}Offsets"] != offsets:
                    raise ValueError("MLP layout offsets differ from its dimensions.")
            identities = numerical["cohort"]["includedMeasurementIds"]
            if (not identities or identities != sorted(set(identities)) or any(type(value) is not int or value < 1 for value in identities)
                    or numerical["cohort"]["includedRows"] != len(identities)):
                raise ValueError("MLP training Measurement identities are invalid.")
            expected = {name: ((sizes[0] if name.startswith("input") else sizes[-1],), np.dtype("float64"))
                        for name in ("inputMinimums", "inputMaximums", "inputMagnitudes", "outputCenter", "outputScale")}
            for index, (left, right) in enumerate(zip(sizes, sizes[1:])):
                expected[f"weight-{index}"] = ((right, left), np.dtype("float32"))
                expected[f"bias-{index}"] = ((right,), np.dtype("float32"))
            names = {"model.json", *(f"{name}.npy" for name in expected)}
            if names != {entry["name"] for entry in manifest["files"]}:
                raise ValueError("MLP artifact does not contain its exact file inventory.")
            for name, (expected_shape, expected_dtype) in expected.items():
                file = path / f"{name}.npy"
                with file.open("rb") as stream:
                    version = np.lib.format.read_magic(stream)
                    if version != (1, 0):
                        raise ValueError("MLP arrays require NumPy format 1.0.")
                    shape, fortran, dtype = np.lib.format.read_array_header_1_0(stream)
                    if (shape != expected_shape or dtype != expected_dtype or fortran
                            or stream.tell() + math.prod(shape) * dtype.itemsize != file.stat().st_size):
                        raise ValueError("MLP array shape, dtype or byte length differs from its network.")
                array = np.load(file, allow_pickle=False, mmap_mode="r")
                try:
                    # Chunked inspection keeps backup and recovery memory bounded.
                    flat = array.reshape(-1)
                    for offset in range(0, flat.size, 65536):
                        if not np.isfinite(flat[offset:offset + 65536]).all():
                            raise ValueError("MLP artifact contains nonfinite numerical values.")
                    if name == "outputScale" and np.any(array < 0):
                        raise ValueError("MLP output scales cannot be negative.")
                    if name.startswith("input"):
                        required = np.concatenate([np.full(value_count(layout), layout["minimum"] if name == "inputMinimums" else
                            layout["maximum"] if name == "inputMaximums" else max(1.0, abs(layout["minimum"]), abs(layout["maximum"])))
                            for layout in numerical["inputLayouts"]])
                        if not np.array_equal(array, required):
                            raise ValueError("MLP input normalization differs from its fixed Vars schema.")
                finally:
                    array._mmap.close()
            return names
        except (ValueError, KeyError, TypeError, IndexError, OSError) as error:
            raise PredictionError("artifact-checksum", str(error)) from error

    @classmethod
    def load(cls, metadata: dict, content: dict, path: Path, files: list[dict], context: ModelExecutionContext):
        names = cls.validate_artifact(path, {"files": files}, content)
        numerical = content["numerical"]
        resources = memory_requirements(numerical["sizes"], 0, 1)
        check_memory(context, resources["persistent"] * 3 + resources["inference"], resources["inference"])
        torch, device = execution_device(context)
        check_memory(context, resources["persistent"] * 3 + resources["inference"], resources["inference"], torch)
        network = None
        try:
            arrays = {}
            for name in sorted(names - {"model.json"}):
                check_cancel(context.cancel)
                arrays[name[:-4]] = np.load(path / name, allow_pickle=False)
            network = make_network(torch, numerical["sizes"])
            with torch.no_grad():
                for index, layer in enumerate(network[::2]):
                    layer.weight.copy_(torch.from_numpy(arrays[f"weight-{index}"]))
                    layer.bias.copy_(torch.from_numpy(arrays[f"bias-{index}"]))
            layer = None
            network.to(device).eval()
            check_cancel(context.cancel)
            return cls(metadata, numerical, arrays, network, torch, device)
        except BaseException as error:
            network = None
            if device.type == "cuda":
                release_cuda_cache(torch)
            if isinstance(error, torch.OutOfMemoryError):
                raise PredictionError("memory-limit", "MLP load exceeded its allocated memory.") from error
            raise
