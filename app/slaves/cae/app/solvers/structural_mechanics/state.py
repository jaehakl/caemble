"""재시작에 필요한 수치 이력만 보관한다. 상태는 Task별로 분리한다."""

import numpy as np

from .continuum import physical_rotation_vectors
from .model import StructuralSolution
from .outputs import physical_support_reactions


def encode_state(model, solution):
    nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    return {"modelIdentity": model.identity, "time": solution.time, "displacement": solution.displacement, "velocity": solution.velocity, "acceleration": solution.acceleration, "orientations": solution.orientations, "reaction": solution.reaction, "elementHistory": solution.element_history, "contactHistory": solution.contact_history, "history": solution.history, "historyNodeIds": model.node_ids[nodes], "strainEnergy": solution.strain_energy, "kineticEnergy": solution.kinetic_energy}


def read_state(model, saved):
    if saved["modelIdentity"] != model.identity:
        raise ValueError("structural checkpoint belongs to a different mesh/material/constraint/integration model")
    nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    if not np.array_equal(saved["historyNodeIds"], model.node_ids[nodes]):
        raise ValueError("structural checkpoint history node selection differs from the requested outputs")
    return StructuralSolution(np.asarray(saved["displacement"]).copy(), np.asarray(saved["velocity"]).copy(), np.asarray(saved["acceleration"]).copy(), np.asarray(saved["orientations"]).copy(), np.asarray(saved["reaction"]).copy(), dict(saved["history"]), list(saved["elementHistory"]), [None] * len(model.elements), float(saved["time"]), strain_energy=float(saved["strainEnergy"]), kinetic_energy=float(saved["kineticEnergy"]), contact_history=list(saved["contactHistory"]))


def history_sample(model, solution, pitch=0.0, torque=0.0):
    """전체 해석 상태에서 기록할 절점과 공통 스칼라만 복사합니다."""
    rotor_speed = generator_speed = 0.0
    if model.rotor is not None:
        r = model.rotor
        axis = solution.orientations[r["nacelleNode"]][:, 0]
        rotor_speed = float(axis @ (solution.velocity[r["hubNode"], 3:] - solution.velocity[r["nacelleNode"], 3:]))
        generator_speed = float(axis @ (solution.velocity[r["generatorNode"], 3:] - solution.velocity[r["nacelleNode"], 3:]))
    nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    rotations = physical_rotation_vectors(model, solution.displacement, solution.orientations)[nodes]
    reactions = physical_support_reactions(model, solution.reaction, solution.displacement)[nodes]
    return {"times": solution.time, "displacement": solution.displacement[nodes, :3].copy(), "rotation": rotations, "velocity": solution.velocity[nodes, :3].copy(), "reaction": reactions[:, :3], "reactionMoment": reactions[:, 3:], "rotorSpeed": rotor_speed, "generatorSpeed": generator_speed, "pitch": pitch, "generatorTorque": torque, "power": torque * generator_speed, "strainEnergy": solution.strain_energy, "kineticEnergy": solution.kinetic_energy}


def append_history(model, solution, pitch=0.0, torque=0.0, *, samples=None):
    """한 시간 구간을 배열 조각 하나로 보관합니다. 이전 조각은 불변입니다.

    내부 시간 단계마다 누적 이력을 복사하지 않고, 구간 안에서 모은 표본을
    한 번만 배열로 포장합니다. 재시도는 기존 checkpoint 조각을 공유하고
    새 구간만 다시 만듭니다. samples 생략 시 초기 시각 등 한 표본을 넣습니다.
    """
    samples = [history_sample(model, solution, pitch, torque)] if samples is None else samples
    if not samples:
        return
    result = {}
    for key in samples[0]:
        chunk = np.asarray([sample[key] for sample in samples], dtype=float)
        chunk.flags.writeable = False
        result[key] = (*solution.history.get(key, ()), chunk)
    solution.history = result
