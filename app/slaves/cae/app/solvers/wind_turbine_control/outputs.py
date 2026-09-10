"""제어 명령을 실제 물리 단위가 구분된 기존 ABI bundle로 내보낸다."""

from app.kernel.api import BundleValue


def build_outputs(config, commands):
    artifacts = {}
    for output in config["outputs"]:
        if output["methodId"] != "control.commands":
            raise ValueError(f"unsupported controller output {output['methodId']}")
        artifacts[output["key"]] = BundleValue("caemble.mechanics/control@1", commands)
    return artifacts
