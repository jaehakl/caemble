"""공력 벡터화 전의 고정 기준 파형과 구간 재시작의 수치 동등성을 검증합니다."""

import numpy as np
from app.solvers.aerodynamic_loading.formulation import aerodynamic_response, oye_step
from app.solvers.structural_mechanics.rotations import rotation_exp


def aero_waveform():
    # Catalog 원본의 사본이 아닌 합성 회전자: 두 polar, 끝점, 전단풍, 편심, 작은 기울기.
    times = np.array([0.0, 0.03, 0.08, 0.13, 0.2])
    radii = np.array([1.0, 3.0, 5.0, 8.0, 10.0])
    settings = {
        "airDensity": 1.2,
        "rotorRadius": 10.0,
        "hubRadius": 1.0,
        "bladeCount": 3,
        "rotorAxis": [1.0, 0.0, 0.0],
        "windTimes": [0.0, 0.2],
        "windVelocities": [[8.0, 0.0, 0.0], [9.0, 0.2, 0.0]],
        "referenceHeight": 80.0,
        "shearExponent": 0.14,
        "dynamicInflow": True,
    }
    angles = np.linspace(-np.pi, np.pi, 37)
    sections = {
        "indices": np.arange(5),
        "radii": radii,
        "lengths": np.array([1.0, 2.0, 2.5, 2.5, 1.0]),
        "chord": np.array([1.1, 1.2, 1.0, 0.9, 0.8]),
        "twist": np.array([0.15, 0.1, 0.07, 0.04, 0.02]),
        "polarIndices": np.array([0, 0, 1, 1, 1]),
        "polarAngles": angles,
        "liftCoefficients": np.array([2.0 * np.sin(angles), 1.8 * np.sin(angles)]),
        "dragCoefficients": np.array(
            [0.01 + 0.1 * np.sin(angles) ** 2, 0.02 + 0.08 * np.sin(angles) ** 2]
        ),
        "momentCoefficients": np.array(
            [-0.02 * np.cos(angles), -0.01 * np.cos(angles)]
        ),
        "aerodynamicOffsets": np.array(
            [
                [0.0, 0.1, 0.02],
                [0.0, -0.2, 0.03],
                [0.0, 0.15, -0.04],
                [0.0, 0.1, 0.01],
                [0.0, -0.1, -0.02],
            ]
        ),
    }
    motion = {
        "times": times,
        "positions": np.empty((5, 5, 3)),
        "orientations": np.empty((5, 5, 3, 3)),
        "velocities": np.empty((5, 5, 3)),
        "angularVelocities": np.empty((5, 5, 3)),
        "couplingIteration": 3,
    }
    for sample, time in enumerate(times):
        span = (
            rotation_exp(np.array([0.0, 0.05 * np.sin(time), 0.0]))
            @ rotation_exp(np.array([0.7 + 1.3 * time, 0.0, 0.0]))
            @ [0.0, 0.0, 1.0]
        )
        tangent = np.cross([1.0, 0.0, 0.0], span)
        tangent /= np.linalg.norm(tangent)
        normal = np.cross(span, tangent)
        pitch = 0.08 + 0.1 * time
        chord = np.cos(pitch) * tangent - np.sin(pitch) * normal
        orientation = np.column_stack((span, chord, np.cross(span, chord)))
        omega = np.array([1.3, 0.05 * np.cos(time), 0.0])
        motion["positions"][sample] = [0.2, 1.0, 80.0] + radii[:, None] * span
        motion["orientations"][sample] = orientation
        motion["velocities"][sample] = [0.1 * time, -0.03, 0.02] + np.cross(
            omega, radii[:, None] * span
        )
        motion["angularVelocities"][sample] = omega - 0.1 * span
    model = {
        "modelIdentity": "synthetic-aero-equivalence",
        "nodeIds": np.arange(5),
        "referencePositions": motion["positions"][0],
    }
    return settings, sections, model, motion


def test_vectorized_aerodynamics_matches_preoptimization_physical_waveform():
    # 벡터화 이전 scalar 구현으로 고정한 기준: [Fx,Fy,Fz,Mx,My,Mz]의 시간 파형.
    # 단위는 N, N.m이며 원소별 알고리즘을 시험 안에 복제하지 않습니다.
    expected = np.array(
        [
            [
                364.5375953385074,
                -280.15091035172,
                -235.9678565654076,
                0.0,
                -8.21861099956988,
                9.757478780665819,
            ],
            [
                374.9261863218088,
                -281.5112315709669,
                -257.09180735884956,
                0.014288675077703306,
                -8.68174675351395,
                9.527205259421583,
            ],
            [
                391.88869722133364,
                -281.5613105790438,
                -293.804454495765,
                0.036336261645887526,
                -9.438562006898369,
                9.093713924343119,
            ],
            [
                408.5189403947704,
                -278.68873882627713,
                -332.32210109059827,
                0.05583331992191352,
                -10.189748370593563,
                8.613863121522137,
            ],
            [
                431.07944785348855,
                -269.1614112730048,
                -388.7599409532622,
                0.07803520644071997,
                -11.2210580581919,
                7.855529530991462,
            ],
        ]
    )
    expected_induced = np.array(
        [
            [8.060448383101432, 0.0],
            [0.42014255766019104, 0.6315381971192577],
            [0.2875985586654184, 0.29598901318653015],
            [0.33524338355883493, 0.21700368104307954],
            [7.912756857742259, 0.0],
        ]
    )
    loads, state, observations = aerodynamic_response(*aero_waveform())
    actual = np.column_stack(
        (loads["forces"].sum(axis=1), loads["moments"].sum(axis=1))
    )
    np.testing.assert_allclose(actual, expected, rtol=2e-12, atol=2e-12)
    np.testing.assert_allclose(
        state["inducedVelocity"], expected_induced, rtol=2e-12, atol=2e-12
    )
    assert observations["maxBEMResidual"] < 1e-8


def test_vectorized_aerodynamics_preserves_checkpoint_replay_and_split_windows():
    settings, sections, model, motion = aero_waveform()
    full, full_state, _ = aerodynamic_response(settings, sections, model, motion)
    first = {
        key: value[:3] if isinstance(value, np.ndarray) else value
        for key, value in motion.items()
    }
    second = {
        key: value[2:] if isinstance(value, np.ndarray) else value
        for key, value in motion.items()
    }
    _, checkpoint, _ = aerodynamic_response(settings, sections, model, first)
    saved = {
        key: value.copy() if isinstance(value, np.ndarray) else value
        for key, value in checkpoint.items()
    }
    resumed, resumed_state, _ = aerodynamic_response(
        settings, sections, model, second, checkpoint
    )
    replay, _, _ = aerodynamic_response(settings, sections, model, second, checkpoint)
    for key in ("forces", "moments"):
        np.testing.assert_allclose(resumed[key], full[key][2:], rtol=2e-12, atol=2e-12)
        np.testing.assert_array_equal(resumed[key], replay[key])
    for key in ("reducedInduction", "inducedVelocity", "quasiSteadyInduction"):
        np.testing.assert_array_equal(checkpoint[key], saved[key])
        np.testing.assert_allclose(
            resumed_state[key], full_state[key], rtol=2e-12, atol=2e-12
        )


def test_vectorized_scatter_sums_multiple_sections_at_the_same_interface_node():
    settings, sections, model, motion = aero_waveform()
    original, _, _ = aerodynamic_response(settings, sections, model, motion)
    repeated = dict(sections)
    for key in (
        "indices",
        "radii",
        "lengths",
        "chord",
        "twist",
        "polarIndices",
        "aerodynamicOffsets",
    ):
        repeated[key] = np.concatenate((sections[key], sections[key]))
    loads, _, _ = aerodynamic_response(settings, repeated, model, motion)
    np.testing.assert_allclose(
        loads["forces"], 2.0 * original["forces"], rtol=2e-12, atol=2e-12
    )
    np.testing.assert_allclose(
        loads["moments"], 2.0 * original["moments"], rtol=2e-12, atol=2e-12
    )


def test_vectorized_oye_matches_each_scalar_filter_including_equal_time_constants():
    reduced = np.array([[0.2, -0.1], [0.3, 0.5], [-0.1, 0.2]])
    induced = np.array([[0.8, -0.2], [0.6, 0.8], [0.3, 0.4]])
    quasi = np.array([[1.0, 0.1], [0.9, 1.2], [0.4, 0.8]])
    tau1, tau2 = 2.0, np.array([2.0, 0.7, 0.3])
    actual_reduced, actual_induced = oye_step(
        reduced, induced, quasi, 0.03, tau1, tau2[:, None]
    )
    for row in range(3):
        expected_reduced, expected_induced = oye_step(
            reduced[row], induced[row], quasi[row], 0.03, tau1, tau2[row]
        )
        np.testing.assert_allclose(
            actual_reduced[row], expected_reduced, rtol=2e-15, atol=2e-15
        )
        np.testing.assert_allclose(
            actual_induced[row], expected_induced, rtol=2e-15, atol=2e-15
        )
