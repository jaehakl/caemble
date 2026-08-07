from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import model_catalog


CATALOG = """
[llm]
default_model = "llm-b"
use_max_gpu = false
context_size = 4096
split_mode = "layer"
tensor_split = []
main_gpu = 0
flash_attn = true
swa_full = false
n_batch = 512
n_ubatch = 512
offload_kqv = true
max_tokens = 256
temperature = 0.5
top_p = 0.9
enable_thinking = false

[[llm.models]]
name = "llm-a"
path = "llm-a.gguf"
[[llm.models]]
name = "llm-b"
path = "llm-b.gguf"
context_size = 8192
split_mode = "none"
flash_attn = false
swa_full = true
n_batch = 256
n_ubatch = 128
offload_kqv = false
max_tokens = 512
temperature = 0.7
top_p = 0.8
enable_thinking = true
n_threads = 4
n_gpu_layers = 8

[sdxl]
default_model = "image-a"
controlnet_scribble_model_id = "scribble-model"
controlnet_openpose_model_id = "pose-model"
step = 30
cfg = 7.0
height = 1024
width = 1024
strength = 1.0
max_chunk_size = 1
seed_min = 0
seed_max = 2147483647
sampler = "euler"
scheduler = ""
format = "png"
scribble_scale = 0.6
scribble_guidance_start = 0.0
scribble_guidance_end = 0.6
pose_scale = 0.9
pose_guidance_start = 0.0
pose_guidance_end = 0.8

[[sdxl.models]]
name = "image-a"
path = "image.safetensors"
step = 24

[[sdxl.models]]
name = "image-b"
path = "image-b.safetensors"
clip_skip = 2

[embeddings]
default_model = "local"
[[embeddings.models]]
name = "local"
path = "embedding"
[[embeddings.models]]
name = "remote"
model_name = "org/model"
local_files_only = true
"""


class ModelCatalogTest(unittest.TestCase):
    def setUp(self) -> None:
        model_catalog.reset_model_catalog_for_tests()

    def tearDown(self) -> None:
        model_catalog.reset_model_catalog_for_tests()

    def test_loads_ordered_models_hides_paths_and_caches_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog_path = root / "models.toml"
            catalog_path.write_text(CATALOG, encoding="utf-8")
            with (
                patch.object(model_catalog, "AI_DIR", root),
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
            ):
                payload = model_catalog.get_model_list_payload("embeddings")
                llm_payload = model_catalog.get_model_list_payload("llm")
                sdxl_payload = model_catalog.get_model_list_payload("sdxl")
                catalog_path.write_text(CATALOG.replace('default_model = "local"', 'default_model = "remote"'), encoding="utf-8")
                cached_payload = model_catalog.get_model_list_payload("embeddings")

        self.assertEqual(payload["default_model"], "local")
        self.assertEqual([model["name"] for model in payload["models"]], ["local", "remote"])
        self.assertNotIn("path", payload["models"][0])
        self.assertEqual(payload["models"][0]["source_type"], "path")
        self.assertEqual(payload["models"][1]["model_name"], "org/model")
        self.assertIsNone(payload["models"][1]["revision"])
        self.assertIsNone(llm_payload["models"][0]["n_threads"])
        self.assertEqual(llm_payload["models"][1]["n_threads"], 4)
        self.assertEqual(llm_payload["models"][1]["n_gpu_layers"], 8)
        self.assertEqual(llm_payload["models"][0]["context_size"], 4096)
        self.assertEqual(llm_payload["models"][1]["context_size"], 8192)
        self.assertNotIn("path", llm_payload["models"][0])
        self.assertNotIn("defaults", llm_payload)
        self.assertEqual(sdxl_payload["models"][0]["step"], 24)
        self.assertEqual(sdxl_payload["models"][0]["cfg"], 7.0)
        self.assertIsNone(sdxl_payload["models"][0]["clip_skip"])
        self.assertEqual(sdxl_payload["models"][1]["step"], 30)
        self.assertEqual(sdxl_payload["models"][1]["clip_skip"], 2)
        self.assertNotIn("path", sdxl_payload["models"][0])
        self.assertEqual(cached_payload["default_model"], "local")

    def test_resolves_default_relative_path_and_named_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog_path = root / "models.toml"
            catalog_path.write_text(CATALOG, encoding="utf-8")
            (root / "llm-a.gguf").write_bytes(b"a")
            (root / "llm-b.gguf").write_bytes(b"b")
            with (
                patch.object(model_catalog, "AI_DIR", root),
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
            ):
                default_model, default_path = model_catalog.resolve_llm_model(None)
                named_model, named_path = model_catalog.resolve_llm_model("llm-a")
                remote_model, remote_source, remote_revision = model_catalog.resolve_embedding_model("remote")

        self.assertEqual(default_model.name, "llm-b")
        self.assertEqual(Path(default_path).name, "llm-b.gguf")
        self.assertEqual(named_model.max_tokens, 256)
        self.assertEqual(Path(named_path).name, "llm-a.gguf")
        self.assertEqual(remote_model.name, "remote")
        self.assertEqual(remote_source, "org/model")
        self.assertIsNone(remote_revision)

    def test_rejects_duplicate_names_unknown_models_and_missing_paths(self) -> None:
        duplicate = CATALOG.replace('name = "llm-b"', 'name = "llm-a"')
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog_path = root / "models.toml"
            catalog_path.write_text(duplicate, encoding="utf-8")
            with (
                patch.object(model_catalog, "AI_DIR", root),
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(RuntimeError) as duplicate_error,
            ):
                model_catalog.get_model_catalog()
            self.assertIn("duplicate llm model name", str(duplicate_error.exception))

            model_catalog.reset_model_catalog_for_tests()
            catalog_path.write_text(CATALOG, encoding="utf-8")
            with (
                patch.object(model_catalog, "AI_DIR", root),
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(ValueError) as unknown_error,
            ):
                model_catalog.get_selected_model_name("llm", "missing")
            self.assertIn("available models: llm-a, llm-b", str(unknown_error.exception))

            with (
                patch.object(model_catalog, "AI_DIR", root),
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(RuntimeError) as path_error,
            ):
                model_catalog.resolve_sdxl_model(None)
            self.assertIn("SDXL checkpoint file not found", str(path_error.exception))

    def test_rejects_invalid_embedding_sources(self) -> None:
        with self.assertRaises(ValueError):
            model_catalog.EmbeddingModelConfig(name="missing", local_files_only=True)
        with self.assertRaises(ValueError):
            model_catalog.EmbeddingModelConfig(
                name="both",
                path="local",
                model_name="org/model",
                revision="a" * 40,
            )
        with self.assertRaises(ValueError):
            model_catalog.EmbeddingModelConfig(name="unpinned", model_name="org/model", revision="main")
        with self.assertRaises(ValueError):
            model_catalog.EmbeddingModelConfig(name="local-revision", path="local", revision="a" * 40)

        unpinned = model_catalog.EmbeddingModelConfig(name="default", model_name="org/model")
        blank_revision = model_catalog.EmbeddingModelConfig(name="blank", model_name="org/model", revision="  ")
        pinned = model_catalog.EmbeddingModelConfig(name="pinned", model_name="org/model", revision="a" * 40)
        self.assertIsNone(unpinned.revision)
        self.assertIsNone(blank_revision.revision)
        self.assertEqual(pinned.revision, "a" * 40)

    def test_effective_llm_model_requires_every_non_optional_parameter(self) -> None:
        with self.assertRaises(ValueError) as error:
            model_catalog.LlmModelConfig(name="incomplete", path="model.gguf")

        self.assertIn("use_max_gpu", str(error.exception))
        self.assertIn("context_size", str(error.exception))
        self.assertIn("max_tokens", str(error.exception))

    def test_rejects_missing_required_common_settings_even_when_a_model_overrides_them(self) -> None:
        missing_common = CATALOG.replace("context_size = 4096\n", "", 1)
        missing_common = missing_common.replace('path = "llm-a.gguf"\n', 'path = "llm-a.gguf"\ncontext_size = 2048\n')
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog_path = root / "models.toml"
            catalog_path.write_text(missing_common, encoding="utf-8")
            with (
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(ValueError) as error,
            ):
                model_catalog.get_model_catalog()

        self.assertIn("context_size", str(error.exception))

    def test_optional_common_setting_is_inherited_and_can_be_overridden(self) -> None:
        common_threads = CATALOG.replace("enable_thinking = false\n", "enable_thinking = false\nn_threads = 2\n", 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog_path = Path(temp_dir) / "models.toml"
            catalog_path.write_text(common_threads, encoding="utf-8")
            with patch.object(model_catalog, "MODELS_FILE", catalog_path):
                payload = model_catalog.get_model_list_payload("llm")

        self.assertEqual(payload["models"][0]["n_threads"], 2)
        self.assertEqual(payload["models"][1]["n_threads"], 4)

    def test_model_override_errors_are_validated_after_common_merge(self) -> None:
        invalid_override = CATALOG.replace("step = 24\n", "step = 0\n", 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog_path = Path(temp_dir) / "models.toml"
            catalog_path.write_text(invalid_override, encoding="utf-8")
            with (
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(ValueError) as error,
            ):
                model_catalog.get_model_list_payload("sdxl")

        self.assertIn("greater than or equal to 1", str(error.exception))

    def test_unknown_model_override_field_is_rejected(self) -> None:
        unknown_override = CATALOG.replace("step = 24\n", "step = 24\nunknown_setting = true\n", 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog_path = Path(temp_dir) / "models.toml"
            catalog_path.write_text(unknown_override, encoding="utf-8")
            with (
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(ValueError) as error,
            ):
                model_catalog.get_model_list_payload("sdxl")

        self.assertIn("unknown_setting", str(error.exception))

    def test_llm_and_sdxl_models_require_name_and_path(self) -> None:
        missing_path = CATALOG.replace('path = "llm-a.gguf"\n', "", 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog_path = Path(temp_dir) / "models.toml"
            catalog_path.write_text(missing_path, encoding="utf-8")
            with (
                patch.object(model_catalog, "MODELS_FILE", catalog_path),
                self.assertRaises(RuntimeError) as error,
            ):
                model_catalog.get_model_catalog()

        self.assertIn("[[llm.models]].path is required", str(error.exception))


if __name__ == "__main__":
    unittest.main()
