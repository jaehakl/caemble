"""실제 OpenFAST 결과를 SI로 변환하고 native 구성요소/전체 파형과 비교한다.

비교값을 감추는 합격 기준은 두지 않는다. 동일한 운동·작용점·단위인지 확인한 뒤
평균 차이와 시간 파형의 RMS/최대 차이를 읽는다. 소스 모델 계수는 built artifact에서 읽는다.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.solvers.aerodynamic_loading.formulation import aerodynamic_response
from app.solvers.hydrodynamic_loading.formulation import hydrodynamic_response
from app.solvers.wind_turbine_control.formulation import control_response
from tests.fea_reference.openfast import CASE_FILE, OPERATING_CASES, REPOSITORY, SUITES

CHANNELS = {
    "times": ("Time", 1),
    "rotorSpeed": ("RotSpeed", np.pi / 30),
    "generatorSpeed": ("GenSpeed", np.pi / 30),
    "pitch": ("BldPitch1", np.pi / 180),
    "generatorTorque": ("GenTq", 1000),
    "electricalPower": ("GenPwr", 1000),
    "aerodynamicThrust": ("RtAeroFxh", 1),
    "aerodynamicTorque": ("RtAeroMxh", 1),
    "bladeTipDeflectionX": ("B1TipTDxr", 1),
    "bladeTipDeflectionY": ("B1TipTDyr", 1),
    "bladeTipDeflectionZ": ("B1TipTDzr", 1),
    "towerDisplacementX": ("TwrTpTDxi", 1),
    "towerGaugeDisplacementX": ("TwHt1TPxi", 1),
    "hydrodynamicForceX": ("HydroFxi", 1),
    "waveElevation": ("Wave1Elev", 1),
    # The official example asks for negated channels. Undo that display sign to
    # compare forces exerted by the support on the structure, K*u - f_external.
    "foundationForceX": ("-ReactFXss", -1),
    "foundationMomentY": ("-ReactMYss", -1),
}


def read_reference(case):
    path = case / Path(CASE_FILE).with_suffix(".out")
    snapshot = path.read_bytes()
    lines = snapshot.decode("utf-8").splitlines()
    header = next(
        index for index, line in enumerate(lines) if line.split()[:1] == ["Time"]
    )
    values = np.loadtxt(lines[header + 2 :])
    raw = dict(zip(lines[header].split(), values.T, strict=True))
    reference = {
        name: raw[source] * scale
        for name, (source, scale) in CHANNELS.items()
        if source in raw
    }
    return raw, reference, hashlib.sha256(snapshot).hexdigest()


def compare_waveforms(native, reference, start, end):
    times = native["times"]
    if np.ndim(times) != 1 or len(times) == 0 or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("native times must be a nonempty increasing vector")
    # Repeated additions of dt can represent .05 as .04999999999999999.
    # Admit only floating-point endpoint noise, never an extra output interval.
    time_tolerance = 1e-12 * max(1., abs(start), abs(end))
    keep = (times >= max(start, reference["times"][0]) - time_tolerance) & (
        times <= min(end, reference["times"][-1]) + time_tolerance
    )
    if not np.any(keep):
        raise ValueError("native/reference requested intervals do not overlap")
    result = {}
    for name, actual in native.items():
        if name == "times" or name not in reference:
            continue
        expected = np.interp(times[keep], reference["times"], reference[name])
        if np.shape(actual) != np.shape(times):
            raise ValueError(f"{name} must be a scalar waveform matching times")
        if not np.all(np.isfinite(actual)) or not np.all(np.isfinite(expected)):
            raise ValueError(f"{name} contains a nonfinite comparison value")
        difference = actual[keep] - expected
        selected_times = times[keep]
        # Time weighting avoids counting the duplicated endpoint of a periodic
        # interval twice and also works when accepted window lengths differ.
        duration = float(selected_times[-1] - selected_times[0])
        if duration > 0:
            mean_reference = float(np.trapezoid(expected, selected_times) / duration)
            mean_native = float(np.trapezoid(actual[keep], selected_times) / duration)
            rms_difference = float(np.sqrt(np.trapezoid(difference**2, selected_times) / duration))
        else:
            mean_reference, mean_native = float(expected[0]), float(actual[keep][0])
            rms_difference = float(abs(difference[0]))
        native_amplitude = float(np.ptp(actual[keep]) / 2)
        reference_amplitude = float(np.ptp(expected) / 2)
        result[name] = {
            "actual_start": float(selected_times[0]),
            "actual_end": float(selected_times[-1]),
            "sample_count": len(selected_times),
            "native_mean": mean_native,
            "openfast_mean": mean_reference,
            "mean_relative_difference": float((mean_native - mean_reference) / mean_reference)
            if abs(mean_reference) > 1e-15
            else None,
            "rms_difference": rms_difference,
            "mean_definition": "trapezoidal time average over the stated comparison interval",
            "maximum_absolute_difference": float(np.max(np.abs(difference))),
            "native_amplitude": native_amplitude,
            "openfast_amplitude": reference_amplitude,
            "amplitude_relative_difference": (native_amplitude / reference_amplitude - 1)
            if reference_amplitude > 1e-15 else None,
            "amplitude_definition": "half of peak-to-peak over the stated comparison interval",
        }
    if not result:
        raise ValueError("no recognized scalar comparison channels")
    return result


def replay_hydrodynamics(tasks, raw, start, end, interval):
    """정지한 구조의 파랑·해류 하중을 비교한다. 움직이는 결과에는 쓰지 않는다.

    HydroDyn 출력은 구조 가속도의 부가질량 반력도 포함한다. 이 독립 비교에서는
    모든 구조 운동을 0으로 고정하므로 native 외력과 같은 물리량이 된다.
    전체 연성 비교에서는 M_added*a를 native 외력에서 별도로 빼야 한다.
    """
    config = tasks["hydrodynamics"]["config"]
    settings = {key: value["value"] if isinstance(value, dict) else value
                for key, value in config["parameters"].items()}
    members = {key: np.asarray(value["value"] if isinstance(value, dict) else value)
               for key, value in config["initializations"][0]["parameters"].items()}
    nodes = next(rule["parameters"] for rule in tasks["structure"]["config"]["initializations"]
                 if rule["methodId"] == "fea.nodes")
    node_ids = np.asarray(nodes["nodeIds"]["value"], dtype=np.int32)
    points = np.asarray(nodes["positions"]["value"], dtype=float)
    lookup = {int(node): index for index, node in enumerate(node_ids)}
    members["indices"] = np.asarray([[lookup[int(node)] for node in pair]
                                    for pair in members["memberNodes"]])
    times = np.linspace(start, end, round((end - start) / interval) + 1)
    model = {"modelIdentity": "openfast-fixed-hydro-replay", "nodeIds": node_ids,
             "referencePositions": points}
    motion = {"times": times, "velocities": np.zeros((len(times), len(points), 3))}
    loads, _, observations = hydrodynamic_response(settings, members, model, motion)
    waves = np.asarray(settings["waveAmplitudes"]) * np.cos(
        -times[:, None] * (2 * np.pi / np.asarray(settings["wavePeriods"]))
        + np.asarray(settings["wavePhases"]))
    return {"times": times, "hydrodynamicForceX": loads["forces"][:, :, 0].sum(axis=1),
            "waveElevation": waves.sum(axis=1)}, observations


def replay_aerodynamics(tasks, raw, start, end, interval, zero_offsets):
    config = tasks["aerodynamics"]["config"]
    settings = {
        key: value["value"] if isinstance(value, dict) else value
        for key, value in config["parameters"].items()
    }
    sections = {
        key: np.asarray(value["value"] if isinstance(value, dict) else value)
        for key, value in config["initializations"][0]["parameters"].items()
    }
    if zero_offsets:
        sections["aerodynamicOffsets"] = np.zeros((len(sections["nodeIds"]), 3))
    structure = tasks["structure"]["config"]["initializations"]
    nodes = next(
        rule["parameters"] for rule in structure if rule["methodId"] == "fea.nodes"
    )
    rotor = next(
        rule["parameters"] for rule in structure if rule["methodId"] == "fea.rotor"
    )
    rotor = {
        key: value["value"] if isinstance(value, dict) else value
        for key, value in rotor.items()
    }
    node_ids = np.asarray(nodes["nodeIds"]["value"], dtype=np.int32)
    reference_positions = np.asarray(nodes["positions"]["value"], dtype=float)
    indices = {int(node): index for index, node in enumerate(node_ids)}
    sections["indices"] = np.array([indices[int(node)] for node in sections["nodeIds"]])
    hub = reference_positions[indices[rotor["hubNode"]]]
    times = np.linspace(start, end, round((end - start) / interval) + 1)
    omega = np.interp(times, raw["Time"], raw["RotSpeed"]) * np.pi / 30
    pitch = np.interp(times, raw["Time"], raw["BldPitch1"]) * np.pi / 180
    pitch_rate = np.gradient(pitch, times) if len(times) > 1 else np.zeros(1)
    azimuth = np.interp(times, raw["Time"], np.unwrap(raw["Azimuth"] * np.pi / 180))
    settings["windTimes"] = [times[0], times[-1]]
    settings["windVelocities"] = [[float(raw["Wind1VelX"][0]), 0, 0]] * 2
    settings["shearExponent"] = 0
    positions = np.broadcast_to(
        reference_positions, (len(times), len(node_ids), 3)
    ).copy()
    orientations = np.broadcast_to(np.eye(3), (len(times), len(node_ids), 3, 3)).copy()
    velocities, angular_velocities = np.zeros_like(positions), np.zeros_like(positions)
    axis = np.asarray(rotor["axis"], dtype=float)
    if not np.allclose(axis, [1, 0, 0]):
        raise ValueError("this replay aligns the rotor with world +X")
    for blade in rotor["bladeNodeIds"]:
        for node_id in blade:
            node = indices[node_id]
            relative = reference_positions[node] - hub
            cosine, sine = np.cos(azimuth), np.sin(azimuth)
            radial = np.column_stack(
                (
                    np.full(len(times), relative[0]),
                    relative[1] * cosine - relative[2] * sine,
                    relative[1] * sine + relative[2] * cosine,
                )
            )
            span = radial / np.linalg.norm(radial, axis=1)[:, None]
            tangent = np.cross(axis, span)
            normal = np.cross(span, tangent)
            chord = np.cos(pitch)[:, None] * tangent - np.sin(pitch)[:, None] * normal
            positions[:, node] = hub + radial
            velocities[:, node] = omega[:, None] * np.cross(axis, radial)
            angular_velocities[:, node] = (
                omega[:, None] * axis - pitch_rate[:, None] * span
            )
            orientations[:, node] = np.stack(
                (span, chord, np.cross(span, chord)), axis=-1
            )
    model = {
        "modelIdentity": "openfast-rigid-replay",
        "nodeIds": node_ids,
        "referencePositions": reference_positions,
    }
    motion = {
        "times": times,
        "positions": positions,
        "orientations": orientations,
        "velocities": velocities,
        "angularVelocities": angular_velocities,
        "pitch": pitch,
        "rotorSpeed": omega,
    }
    loads, _, observations = aerodynamic_response(settings, sections, model, motion)
    thrust = np.sum(loads["forces"][:, :, 0], axis=1)
    torque = np.sum(
        (np.cross(positions - hub, loads["forces"]) + loads["moments"])[:, :, 0], axis=1
    )
    return (
        {"times": times, "aerodynamicThrust": thrust, "aerodynamicTorque": torque},
        observations,
        len(sections["indices"]),
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["summarize", "replay-aero", "replay-hydro", "compare"])
    parser.add_argument(
        "--directory", type=Path, default=REPOSITORY / ".work/openfast-reference"
    )
    parser.add_argument("--suite", choices=SUITES, default="original")
    parser.add_argument("--case")
    parser.add_argument("--built", type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--start", type=float)
    parser.add_argument("--end", type=float)
    parser.add_argument("--interval", type=float, default=0.05)
    parser.add_argument("--zero-offsets", action="store_true")
    args = parser.parse_args()
    tasks = None
    if args.built:
        tasks = json.loads(args.built.read_text(encoding="utf-8"))["measurement"][
            "experiment"
        ]["simulationProgram"]["tasks"]
    if args.action in ("replay-aero", "replay-hydro") and tasks is None:
        parser.error("--built is required for native physical coefficients and mesh")
    if args.action == "replay-hydro" and args.case != "fixedhydro":
        parser.error("replay-hydro requires --case fixedhydro, with all structural motion disabled")
    if args.action == "compare" and (args.native is None or args.case is None):
        parser.error(
            "--native and --case are required for a native waveform comparison"
        )
    cases = (
        [args.case]
        if args.case
        else [SUITES[args.suite] + suffix for suffix, *_ in OPERATING_CASES]
    )
    for name in cases:
        started = time.perf_counter()
        case = args.directory.resolve() / "model" / name
        raw, reference, digest = read_reference(case)
        start = (0 if "rigid" in name or name == "fixedhydro" else 240) if args.start is None else args.start
        end = (16 if name == "fixedhydro" else 2 if "rigid" in name else 300) if args.end is None else args.end
        selected = (reference["times"] >= start) & (reference["times"] <= end)
        if not np.any(selected):
            raise ValueError("requested interval has no reference samples")
        report = {"case": name, "output_sha256": digest, "start": start, "end": end}
        if args.built:
            report["built_sha256"] = hashlib.sha256(args.built.read_bytes()).hexdigest()
        if args.action == "summarize":
            np.savez_compressed(case / "reference_si.npz", **reference)
            report["channel_mapping"] = CHANNELS
            report["sample_count"] = int(np.sum(selected))
            report["statistics"] = {
                key: {
                    "mean": float(np.mean(values[selected])),
                    "std": float(np.std(values[selected])),
                    "minimum": float(np.min(values[selected])),
                    "maximum": float(np.max(values[selected])),
                }
                for key, values in reference.items()
                if key != "times"
            }
            if tasks is not None and "generatorTorque" in reference:
                settings = {
                    key: value["value"] if isinstance(value, dict) else value
                    for key, value in tasks["control"]["config"]["parameters"].items()
                }
                settings.update(
                    initialPitch=float(reference["pitch"][0]),
                    initialGeneratorTorque=float(reference["generatorTorque"][0]),
                )
                commands, _, _ = control_response(
                    settings,
                    {
                        "modelIdentity": name,
                        "times": reference["times"],
                        "generatorSpeed": reference["generatorSpeed"],
                    },
                )
                native = {
                    key: commands[key] for key in ["times", "pitch", "generatorTorque"]
                }
                np.savez_compressed(case / "native_controller_replay.npz", **native)
                report["controller_replay"] = compare_waveforms(
                    native, reference, start, end
                )
            destination = "reference_analysis.json"
        elif args.action == "replay-aero":
            native, observations, station_count = replay_aerodynamics(
                tasks, raw, start, end, args.interval, args.zero_offsets
            )
            np.savez_compressed(case / "native_aerodynamic_replay.npz", **native)
            report.update(
                sample_interval=args.interval,
                aerodynamic_station_count=station_count,
                observations=observations,
                aerodynamic_offsets="zero diagnostic"
                if args.zero_offsets
                else "Catalog source values",
                kinematics="rigid blades driven by actual rotor speed, azimuth and pitch; elastic deformation omitted",
                initialization="equilibrium native dynamic inflow at analysis start",
            )
            report["comparison"] = compare_waveforms(native, reference, start, end)
            destination = "aerodynamic_replay_analysis.json"
        elif args.action == "replay-hydro":
            native, observations = replay_hydrodynamics(tasks, raw, start, end, args.interval)
            np.savez_compressed(case / "native_hydrodynamic_replay.npz", **native)
            report.update(observations=observations, sample_interval=args.interval,
                          kinematics="all body velocities and accelerations fixed to zero")
            report["comparison"] = compare_waveforms(native, reference, start, end)
            destination = "hydrodynamic_replay_analysis.json"
        else:
            with np.load(args.native, allow_pickle=False) as archive:
                native = {key: archive[key] for key in archive.files}
            report["native_comparison"] = compare_waveforms(
                native, reference, start, end
            )
            destination = "native_comparison.json"
        report["elapsed_seconds"] = time.perf_counter() - started
        (case / destination).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
