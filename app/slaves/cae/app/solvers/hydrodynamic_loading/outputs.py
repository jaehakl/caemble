"""물의 외력과 부가질량을 하나의 명시적 하중 bundle로 전달한다."""

from app.kernel.api import BundleValue


def build_outputs(config, loads):
    artifacts = {}
    for output in config["outputs"]:
        if output["methodId"] != "hydro.loads":
            raise ValueError(f"unsupported hydrodynamic output {output['methodId']}")
        artifacts[output["key"]] = BundleValue("caemble.mechanics/loads@1", loads)
    return artifacts
