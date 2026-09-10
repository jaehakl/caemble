"""요청한 공력 output만 기존 ABI bundle로 만든다."""

from app.kernel.api import BundleValue


def build_outputs(config, loads):
    artifacts = {}
    for output in config["outputs"]:
        if output["methodId"] != "aero.loads":
            raise ValueError(f"unsupported aerodynamic output {output['methodId']}")
        artifacts[output["key"]] = BundleValue("caemble.mechanics/loads@1", loads)
    return artifacts
