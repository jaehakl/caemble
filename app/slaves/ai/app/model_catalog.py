from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from app.settings import AI_DIR


MODELS_FILE = AI_DIR / "models.toml"
MODEL_FAMILIES = ("llm", "sdxl", "embeddings")


class StrictConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CatalogModel(StrictConfig):
    name: str = Field(min_length=1)


class LlmGenerationSettingsConfig(StrictConfig):
    context_size: int
    max_tokens: int
    temperature: float
    top_p: float
    enable_thinking: bool


class LlmSettingsConfig(LlmGenerationSettingsConfig):
    use_max_gpu: bool
    split_mode: Literal["none", "layer", "row", "tensor"]
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
    name: str = Field(min_length=1)
    provider: Literal["llama_cpp"] = "llama_cpp"
    path: str = Field(min_length=1)
    model_id: None = None


class OpenAiLlmModelConfig(LlmGenerationSettingsConfig):
    name: str = Field(min_length=1)
    provider: Literal["openai"]
    model_id: str = Field(min_length=1)
    path: None = None

    @field_validator("model_id")
    @classmethod
    def normalize_model_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("model_id must not be blank")
        return value


class OpenAiProviderConfig(StrictConfig):
    api_key: SecretStr

    @model_validator(mode="after")
    def validate_api_key(self) -> "OpenAiProviderConfig":
        normalized = self.api_key.get_secret_value().strip()
        if not normalized:
            raise ValueError("api_key must not be blank")
        self.api_key = SecretStr(normalized)
        return self


LlmCatalogModel = LlmModelConfig | OpenAiLlmModelConfig


class SdxlSettingsConfig(StrictConfig):
    controlnet_scribble_model_id: str
    controlnet_openpose_model_id: str
    step: int = Field(ge=1, le=150)
    cfg: float = Field(ge=0.0, le=30.0)
    height: int = Field(ge=64, le=2048)
    width: int = Field(ge=64, le=2048)
    strength: float = Field(ge=0.0, le=1.0)
    max_chunk_size: int = Field(ge=1, le=8)
    seed_min: int = Field(ge=0)
    seed_max: int = Field(ge=0)
    sampler: str
    scheduler: str
    clip_skip: int | None = Field(default=None, ge=1, le=12)
    format: Literal["png", "jpg", "jpeg"]
    scribble_scale: float = Field(ge=0.0, le=2.0)
    scribble_guidance_start: float = Field(ge=0.0, le=1.0)
    scribble_guidance_end: float = Field(ge=0.0, le=1.0)
    pose_scale: float = Field(ge=0.0, le=2.0)
    pose_guidance_start: float = Field(ge=0.0, le=1.0)
    pose_guidance_end: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_ranges(self) -> "SdxlSettingsConfig":
        if self.seed_min > self.seed_max:
            raise ValueError("seed_min must be less than or equal to seed_max")
        if self.height % 8 != 0 or self.width % 8 != 0:
            raise ValueError("height and width must be multiples of 8")
        if self.scribble_guidance_end < self.scribble_guidance_start:
            raise ValueError("scribble guidance end must be greater than or equal to start")
        if self.pose_guidance_end < self.pose_guidance_start:
            raise ValueError("pose guidance end must be greater than or equal to start")
        return self


class SdxlModelConfig(SdxlSettingsConfig):
    name: str = Field(min_length=1)
    path: str = Field(min_length=1)


class EmbeddingModelConfig(CatalogModel):
    path: str | None = None
    model_name: str | None = None
    revision: str | None = None
    local_files_only: bool = True

    @model_validator(mode="after")
    def validate_source(self) -> "EmbeddingModelConfig":
        has_path = bool(self.path and self.path.strip())
        has_model_name = bool(self.model_name and self.model_name.strip())
        revision = (self.revision or "").strip()
        if has_path == has_model_name:
            raise ValueError("exactly one of path or model_name is required")
        if has_model_name and revision:
            if len(revision) != 40 or any(char not in "0123456789abcdefABCDEF" for char in revision):
                raise ValueError("revision must be a 40-character commit SHA")
        elif not has_model_name and revision:
            raise ValueError("revision is only supported with model_name")
        self.revision = revision or None
        return self


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


def reset_model_catalog_for_tests() -> None:
    global _catalog
    _catalog = None


def get_model_list_payload(family: str) -> dict[str, Any]:
    catalog = get_model_catalog()
    public_models = []
    for raw_model in catalog.models[family]:
        if family == "llm":
            model = _validate_llm_model(raw_model)
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
    model = _validate_llm_model(_select_raw_model("llm", name))
    if not isinstance(model, LlmModelConfig):
        raise ValueError(f"LLM model '{model.name}' is not a llama_cpp model")
    return model, _resolve_model_path(model.path, "LLM model file", require_file=True)


def resolve_llm_selection(name: str | None) -> LlmModelSelection:
    catalog = get_model_catalog()
    model = _validate_llm_model(_select_raw_model("llm", name))
    if isinstance(model, OpenAiLlmModelConfig):
        if catalog.openai is None:
            raise RuntimeError("models.toml [llm.openai].api_key is required for OpenAI models")
        return LlmModelSelection(model=model, api_key=catalog.openai.api_key)
    return LlmModelSelection(model=model)


def resolve_sdxl_model(name: str | None) -> tuple[SdxlModelConfig, str]:
    model = SdxlModelConfig.model_validate(_select_raw_model("sdxl", name))
    return model, _resolve_model_path(model.path, "SDXL checkpoint file", require_file=True)


def resolve_embedding_model(name: str | None) -> tuple[EmbeddingModelConfig, str, str | None]:
    model = EmbeddingModelConfig.model_validate(_select_raw_model("embeddings", name))
    if model.path:
        return model, _resolve_model_path(model.path, "Embedding model path"), None
    return model, str(model.model_name), model.revision


def _select_raw_model(family: str, name: str | None) -> dict[str, Any]:
    catalog = get_model_catalog()
    selected_name = name.strip() if name is not None else catalog.defaults[family]
    for model in catalog.models[family]:
        if model["name"] == selected_name:
            return model
    available = ", ".join(model["name"] for model in catalog.models[family])
    raise ValueError(f"unknown {family} model '{selected_name}'; available models: {available}")


def _resolve_model_path(value: str, label: str, require_file: bool = False) -> str:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = AI_DIR / path
    try:
        resolved_path = path.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError(f"{label} not found: {path}") from exc
    if require_file and not resolved_path.is_file():
        raise RuntimeError(f"{label} is not a file: {resolved_path}")
    return str(resolved_path)


def _load_model_catalog() -> ModelCatalog:
    try:
        with MODELS_FILE.open("rb") as file:
            raw_catalog = tomllib.load(file)
    except OSError as exc:
        raise RuntimeError(f"AI model catalog not found: {MODELS_FILE}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise RuntimeError(f"Invalid AI model catalog TOML: {exc}") from exc

    defaults: dict[str, str] = {}
    models: dict[str, tuple[dict[str, Any], ...]] = {}
    openai_config: OpenAiProviderConfig | None = None
    for family in MODEL_FAMILIES:
        section = raw_catalog.get(family)
        if not isinstance(section, dict):
            raise RuntimeError(f"models.toml [{family}] section is required")
        default_model = section.get("default_model")
        raw_models = section.get("models")
        if not isinstance(default_model, str) or not default_model.strip():
            raise RuntimeError(f"models.toml [{family}].default_model is required")
        if not isinstance(raw_models, list) or not raw_models:
            raise RuntimeError(f"models.toml [[{family}.models]] must contain at least one model")
        common_values: dict[str, Any] = {}
        if family == "llm":
            raw_common = {
                key: value
                for key, value in section.items()
                if key not in {"default_model", "models", "openai"}
            }
            common_values = LlmSettingsConfig.model_validate(raw_common).model_dump()
            raw_openai = section.get("openai")
            if raw_openai is not None:
                if not isinstance(raw_openai, dict):
                    raise RuntimeError("models.toml [llm.openai] must be a table")
                openai_config = OpenAiProviderConfig.model_validate(raw_openai)
        elif family in COMMON_CONFIG_TYPES:
            raw_common = {
                key: value
                for key, value in section.items()
                if key not in {"default_model", "models"}
            }
            common_values = COMMON_CONFIG_TYPES[family].model_validate(raw_common).model_dump()

        names: list[str] = []
        copied_models: list[dict[str, Any]] = []
        for raw_model in raw_models:
            if not isinstance(raw_model, dict):
                raise RuntimeError(f"models.toml [[{family}.models]] entries must be tables")
            name = raw_model.get("name")
            if not isinstance(name, str) or not name.strip():
                raise RuntimeError(f"models.toml [[{family}.models]].name is required")
            if family == "llm":
                provider = raw_model.get("provider", "llama_cpp")
                if provider == "llama_cpp":
                    path = raw_model.get("path")
                    if not isinstance(path, str) or not path.strip():
                        raise RuntimeError("models.toml [[llm.models]].path is required for llama_cpp models")
                    copied_model = {**common_values, **raw_model, "provider": "llama_cpp"}
                elif provider == "openai":
                    model_id = raw_model.get("model_id")
                    if not isinstance(model_id, str) or not model_id.strip():
                        raise RuntimeError("models.toml [[llm.models]].model_id is required for OpenAI models")
                    generation_values = {
                        key: common_values[key]
                        for key in LlmGenerationSettingsConfig.model_fields
                    }
                    copied_model = {**generation_values, **raw_model, "provider": "openai"}
                else:
                    raise RuntimeError(
                        f"models.toml [[llm.models]].provider must be 'llama_cpp' or 'openai': {provider}"
                    )
                _validate_llm_model(copied_model)
            elif family in COMMON_CONFIG_TYPES:
                path = raw_model.get("path")
                if not isinstance(path, str) or not path.strip():
                    raise RuntimeError(f"models.toml [[{family}.models]].path is required")
                copied_model = {**common_values, **raw_model}
                MODEL_CONFIG_TYPES[family].model_validate(copied_model)
            else:
                copied_model = {**common_values, **raw_model}
                MODEL_CONFIG_TYPES[family].model_validate(copied_model)
            name = name.strip()
            if name in names:
                raise RuntimeError(f"duplicate {family} model name: {name}")
            names.append(name)
            copied_model["name"] = name
            copied_models.append(copied_model)
        default_model = default_model.strip()
        if default_model not in names:
            raise RuntimeError(f"default {family} model is not registered: {default_model}")
        defaults[family] = default_model
        models[family] = tuple(copied_models)
    if any(model.get("provider") == "openai" for model in models["llm"]) and openai_config is None:
        raise RuntimeError("models.toml [llm.openai].api_key is required for OpenAI models")
    return ModelCatalog(defaults=defaults, models=models, openai=openai_config)


def _validate_llm_model(raw_model: dict[str, Any]) -> LlmCatalogModel:
    if raw_model.get("provider", "llama_cpp") == "openai":
        return OpenAiLlmModelConfig.model_validate(raw_model)
    return LlmModelConfig.model_validate(raw_model)
