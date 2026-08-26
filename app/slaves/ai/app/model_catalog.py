from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, SecretStr

from app.settings import AI_DIR


MODELS_FILE = AI_DIR / "models.toml"
MODEL_FAMILIES = ("llm", "sdxl", "embeddings")


class CatalogModel(BaseModel):
    name: str


class LlmGenerationSettingsConfig(BaseModel):
    context_size: int
    max_tokens: int
    temperature: float
    top_p: float
    enable_thinking: bool


class LlmSettingsConfig(LlmGenerationSettingsConfig):
    use_max_gpu: bool
    split_mode: str
    tensor_split: list[float]
    main_gpu: int
    flash_attn: bool
    swa_full: bool
    n_batch: int
    n_ubatch: int
    offload_kqv: bool
    n_threads: int | None = None
    n_gpu_layers: int | None = None


class LlmModelConfig(LlmSettingsConfig):
    name: str
    provider: str = "llama_cpp"
    path: str
    model_id: None = None


class OpenAiLlmModelConfig(LlmGenerationSettingsConfig):
    name: str
    provider: str = "openai"
    model_id: str
    path: None = None


class OpenAiProviderConfig(BaseModel):
    api_key: SecretStr


LlmCatalogModel = LlmModelConfig | OpenAiLlmModelConfig


class SdxlSettingsConfig(BaseModel):
    controlnet_scribble_model_id: str
    controlnet_openpose_model_id: str
    step: int
    cfg: float
    height: int
    width: int
    strength: float
    max_chunk_size: int
    seed_min: int
    seed_max: int
    sampler: str
    scheduler: str
    clip_skip: int | None = None
    format: str
    scribble_scale: float
    scribble_guidance_start: float
    scribble_guidance_end: float
    pose_scale: float
    pose_guidance_start: float
    pose_guidance_end: float


class SdxlModelConfig(SdxlSettingsConfig):
    name: str
    path: str


class EmbeddingModelConfig(CatalogModel):
    path: str | None = None
    model_name: str | None = None
    revision: str | None = None
    local_files_only: bool = True


MODEL_CONFIG_TYPES = {
    "sdxl": SdxlModelConfig,
    "embeddings": EmbeddingModelConfig,
}
COMMON_CONFIG_TYPES = {
    "sdxl": SdxlSettingsConfig,
}


@dataclass(frozen=True)
class ModelCatalog:
    defaults: dict[str, str]
    models: dict[str, tuple[dict[str, Any], ...]]
    openai: OpenAiProviderConfig | None = None


@dataclass(frozen=True)
class LlmModelSelection:
    model: LlmCatalogModel
    api_key: SecretStr | None = None


_catalog: ModelCatalog | None = None


def get_model_catalog() -> ModelCatalog:
    global _catalog
    if _catalog is None:
        _catalog = _load_model_catalog()
    return _catalog


def get_model_list_payload(family: str) -> dict[str, Any]:
    catalog = get_model_catalog()
    public_models = []
    for raw_model in catalog.models[family]:
        if family == "llm":
            model = _parse_llm_model(raw_model)
            public = model.model_dump(exclude={"path", "model_id"})
        else:
            model = MODEL_CONFIG_TYPES[family].model_validate(raw_model)
            public = model.model_dump(exclude={"path"})
        if family == "embeddings":
            public["source_type"] = "path" if model.path else "huggingface"
        public_models.append(public)
    return {"default_model": catalog.defaults[family], "models": public_models}


def get_selected_model_name(family: str, name: str | None) -> str:
    return str(_select_raw_model(family, name)["name"])


def resolve_llm_model(name: str | None) -> tuple[LlmModelConfig, str]:
    model = LlmModelConfig.model_validate(_select_raw_model("llm", name))
    return model, _resolve_model_path(model.path)


def resolve_llm_selection(name: str | None) -> LlmModelSelection:
    catalog = get_model_catalog()
    model = _parse_llm_model(_select_raw_model("llm", name))
    if isinstance(model, OpenAiLlmModelConfig):
        if catalog.openai is None:
            raise RuntimeError("models.toml [llm.openai].api_key is required for OpenAI models")
        return LlmModelSelection(model=model, api_key=catalog.openai.api_key)
    return LlmModelSelection(model=model)


def resolve_sdxl_model(name: str | None) -> tuple[SdxlModelConfig, str]:
    model = SdxlModelConfig.model_validate(_select_raw_model("sdxl", name))
    return model, _resolve_model_path(model.path)


def resolve_embedding_model(name: str | None) -> tuple[EmbeddingModelConfig, str, str | None]:
    model = EmbeddingModelConfig.model_validate(_select_raw_model("embeddings", name))
    if model.path:
        return model, _resolve_model_path(model.path), None
    return model, str(model.model_name), model.revision


def _select_raw_model(family: str, name: str | None) -> dict[str, Any]:
    catalog = get_model_catalog()
    selected_name = name.strip() if name is not None else catalog.defaults[family]
    for model in catalog.models[family]:
        if model["name"] == selected_name:
            return model
    raise KeyError(selected_name)


def _resolve_model_path(value: str) -> str:
    path = Path(value).expanduser()
    return str((path if path.is_absolute() else AI_DIR / path).resolve())


def _load_model_catalog() -> ModelCatalog:
    with MODELS_FILE.open("rb") as file:
        raw_catalog = tomllib.load(file)

    defaults: dict[str, str] = {}
    models: dict[str, tuple[dict[str, Any], ...]] = {}
    openai_config: OpenAiProviderConfig | None = None
    for family in MODEL_FAMILIES:
        section = raw_catalog[family]
        defaults[family] = str(section["default_model"])
        common_values: dict[str, Any] = {}
        if family == "llm":
            common_values = LlmSettingsConfig.model_validate(
                {key: value for key, value in section.items() if key not in {"default_model", "models", "openai"}}
            ).model_dump()
            if section.get("openai") is not None:
                openai_config = OpenAiProviderConfig.model_validate(section["openai"])
        elif family in COMMON_CONFIG_TYPES:
            common_values = COMMON_CONFIG_TYPES[family].model_validate(
                {key: value for key, value in section.items() if key not in {"default_model", "models"}}
            ).model_dump()

        copied_models: list[dict[str, Any]] = []
        for raw_model in section["models"]:
            if family == "llm" and raw_model.get("provider", "llama_cpp") == "openai":
                generation_values = {
                    key: common_values[key]
                    for key in LlmGenerationSettingsConfig.model_fields
                }
                copied_model = OpenAiLlmModelConfig.model_validate(
                    {**generation_values, **raw_model, "provider": "openai"}
                ).model_dump()
            elif family == "llm":
                copied_model = LlmModelConfig.model_validate(
                    {**common_values, **raw_model, "provider": "llama_cpp"}
                ).model_dump()
            else:
                copied_model = MODEL_CONFIG_TYPES[family].model_validate(
                    {**common_values, **raw_model}
                ).model_dump()
            copied_models.append(copied_model)
        models[family] = tuple(copied_models)
    return ModelCatalog(defaults=defaults, models=models, openai=openai_config)


def _parse_llm_model(raw_model: dict[str, Any]) -> LlmCatalogModel:
    if raw_model.get("provider", "llama_cpp") == "openai":
        return OpenAiLlmModelConfig.model_validate(raw_model)
    return LlmModelConfig.model_validate(raw_model)
