from service.geometry.source import validate_experiment_tsx_imports


def validate_material_source_imports(source: str) -> None:
    validate_experiment_tsx_imports(source, path="material.tsx")
