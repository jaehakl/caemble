"""External load transfer and physical support resultants."""

import numpy as np

from ..domain import distribute_resultant, parameter, surface_region
from ..rotations import skew


def apply_resultant_loads(invocation, model):
    """전체 모델의 순간 외력을 상세 모델에 힘/모멘트 보존으로 옮긴다.

    기준점에 대한 합력 F[N], 합모멘트 M[N m]를 먼저 계산한다. 상세 모델의
    절점 i에서 강체 가상운동은 δu_i=B_i[δu,δθ], B_i=[I,-skew(r_i)]다.
    f_i=B_i(ΣBᵀB)^(-1)[F,M]으로 분배하면 ΣB_iᵀf_i=[F,M]이므로 합력,
    합모멘트와 강체 가상일을 모두 보존한다. 절점력의 최소 제곱 해다.
    수력 Solver의 forces는 부가질량을 좌변에 둔 가진력이다. 여기서는
    F_physical=F_excitation-M_added[kg]·a_source[m/s²]로 실제 유체력을 먼저
    복원한다. 이는 원래 전역 동역학의 질량 조립을 변경하거나 중복하지 않는다.
    상세 해석은 순간 외력만 받는 준정적 해석이며 구조 자체의 중력/관성력이나
    경계의 실제 응력 분포까지 복원하는 substructuring은 아니다.
    """
    rules = [rule for rule in invocation.config["boundaryConditions"] if rule["methodId"] == "fea.resultant-transfer"]
    if not rules:
        return
    motion_input = invocation.inputs.get("sourceMotion")
    source_inputs = invocation.inputs.get("sourceLoads", ())
    if not isinstance(source_inputs, (list, tuple)):
        source_inputs = (source_inputs,)
    if motion_input is None or not source_inputs:
        raise ValueError("resultant transfer requires sourceMotion and sourceLoads artifacts")
    motion = motion_input.value.members
    source_ids = np.asarray(motion["nodeIds"])
    source_lookup = {int(node): index for index, node in enumerate(source_ids)}
    target_lookup = {int(node): index for index, node in enumerate(model.node_ids)}
    force = np.zeros((len(source_ids), 3))
    moment = np.zeros_like(force)
    for item in source_inputs:
        load = item.value.members
        if load["modelIdentity"] != motion["modelIdentity"] or not np.array_equal(load["nodeIds"], source_ids) or not np.array_equal(load["times"], motion["times"]):
            raise ValueError("resultant transfer source identities, node IDs and times must agree")
        force += np.asarray(load["forces"])[-1]
        moment += np.asarray(load["moments"])[-1]
        added_mass = np.asarray(load.get("addedMass", np.zeros((len(source_ids), 3, 3))))
        if added_mass.shape != (len(source_ids), 3, 3):
            raise ValueError("resultant transfer added mass must match source nodes")
        if np.any(added_mass):
            if "accelerations" not in motion:
                raise ValueError("resultant transfer of added mass requires source accelerations")
            acceleration = np.asarray(motion["accelerations"])[-1]
            if acceleration.shape != (len(source_ids), 3):
                raise ValueError("resultant transfer acceleration must match source nodes")
            force -= np.einsum("nij,nj->ni", added_mass, acceleration)
    for rule in rules:
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if "sourceRegion" in p:
            regions = motion_input.value.metadata.get("regions", {})
            if p["sourceRegion"] not in regions or not len(regions[p["sourceRegion"]]):
                raise ValueError("resultant transfer sourceRegion is absent from sourceMotion geometry metadata")
            source = np.asarray([source_lookup[int(node)] for node in regions[p["sourceRegion"]]])
            region = surface_region(model, rule["target"][0])
            target = region["nodes"]
        else:
            # Explicit arrays are retained only for internal numerical fixtures.
            if model.physical_node_count is not None:
                raise ValueError("generated structural models require a semantic sourceRegion for resultant transfer")
            source = np.asarray([source_lookup[int(node)] for node in p["sourceNodeIds"]])
            target = np.asarray([target_lookup[int(node)] for node in p["targetNodeIds"]])
        if len(set(source)) != len(source) or len(set(target)) != len(target) or not len(source):
            raise ValueError("resultant transfer requires unique nonempty source and target node IDs")
        reference = np.asarray(p["referencePoint"], dtype=float)
        arms = np.asarray(motion["positions"])[-1, source] - reference
        resultant = np.r_[force[source].sum(axis=0), (moment[source] + np.cross(arms, force[source])).sum(axis=0)]
        if "sourceRegion" in p:
            target, distributed = distribute_resultant(model.points, region["faces"], resultant[:3], resultant[3:], reference)
            np.add.at(model.force[:, :3], target, distributed)
            continue
        # m와 rad의 서로 다른 척도로 인한 조건수 악화를 막기 위해 팔 길이를 정규화한다.
        target_arms = model.points[target] - reference
        length = max(np.max(np.linalg.norm(target_arms, axis=1), initial=0), 1e-12)
        blocks = np.asarray([np.column_stack((np.eye(3), -skew(arm / length))) for arm in target_arms])
        metric = np.einsum("nji,njk->ik", blocks, blocks)
        if np.linalg.matrix_rank(metric) < 6:
            raise ValueError("resultant transfer needs at least three noncollinear target nodes")
        generalized = np.r_[resultant[:3], resultant[3:] / length]
        distributed = np.einsum("nij,j->ni", blocks, np.linalg.solve(metric, generalized))
        np.add.at(model.force[:, :3], target, distributed)


def physical_support_reactions(model, reaction, displacement):
    """Map fixed attachment wrenches back to their physical surface nodes.

    The numerical constraint owns six support reactions at an auxiliary
    reference node.  Public physical fields and semantic surface histories do
    not expose that solver-created node, so its wrench is conservatively
    distributed on the current attachment patch without changing the solved
    reaction array.
    """
    result = np.asarray(reaction).copy()
    physical_count = getattr(model, "physical_node_count", None)
    if physical_count is None:
        return result
    fixed = set(map(int, model.fixed))
    current = model.points + np.asarray(displacement)[:, :3]
    for target, node in model.provenance.get("auxiliaryNodes", {}).items():
        node = int(node)
        if target not in model.boundary_regions or not all(6 * node + component in fixed for component in range(6)):
            continue
        region = model.boundary_regions[target]
        nodes, forces = distribute_resultant(
            current, np.asarray(region["faces"], dtype=int), result[node, :3],
            result[node, 3:], current[node],
        )
        np.add.at(result[:, :3], nodes, forces)
    return result
