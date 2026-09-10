"""운전 파형의 사전에 정한 평균 5% / 진폭 10% 기준을 엄격히 검사한다.

충분히 긴 구간인지와 양쪽 실행 완료를 확인한다. 정상상태 여부를 시간 길이만으로
추론하지 않으며, 구간 전후반의 평균 차이도 별도로 남겨 그 판단을 돕는다.
영인 기준값에 임의 분모나 새 허용값을 더하지 않는다.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from compare import compare_waveforms, read_reference

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-run", type=Path, required=True)
    parser.add_argument("--reference-case", type=Path, required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    native_path = args.native_run / "comparison_si.npz"
    native_evidence = json.loads((args.native_run / "report.json").read_text(encoding="utf-8"))
    reference_evidence = json.loads((args.reference_case / "execution.json").read_text(encoding="utf-8"))
    if native_evidence["status"]["kind"] != "complete" or reference_evidence["exit_code"] != 0 or not reference_evidence["normal_termination"]:
        raise ValueError("qualification requires two normally completed executions")
    if native_evidence.get("sourceFilesChangedDuringRun") is not False:
        raise ValueError("qualification requires evidence that Solver sources stayed unchanged")
    if args.end - args.start < 60 - 1e-10:
        raise ValueError("the steady-operation comparison protocol requires at least 60 s")
    with np.load(native_path, allow_pickle=False) as archive:
        native = dict(archive)
    _, reference, reference_hash = read_reference(args.reference_case)
    for name, data in (("native", native), ("OpenFAST", reference)):
        times = data["times"]
        if args.start < times[0] - 1e-9 or args.end > times[-1] + 1e-9:
            raise ValueError(f"{name} does not cover the entire requested interval")
        selected = times[(times >= args.start - 1e-9) & (times <= args.end + 1e-9)]
        if len(selected) < 2 or np.max(np.diff(selected)) > .005 + 1e-9:
            raise ValueError(f"{name} needs actual waveform samples at intervals <= .005 s")
    channels = ("rotorSpeed", "pitch", "electricalPower", "bladeTipDeflectionX",
                "towerDisplacementX", "foundationForceX", "foundationMomentY")
    if any(name not in native or name not in reference for name in channels):
        raise ValueError("all seven required operating response channels must be present")
    statistics = compare_waveforms(native, reference, args.start, args.end)
    report = {"native_sha256": hashlib.sha256(native_path.read_bytes()).hexdigest(),
              "reference_sha256": reference_hash, "start": args.start, "end": args.end,
              "native_execution": native_evidence["execution"],
              "source_files_changed_during_run": native_evidence.get("sourceFilesChangedDuringRun"),
              "criteria": {"mean_relative_difference": .05, "amplitude_relative_difference": .10},
              "stationarity": "Not inferred automatically; inspect half-interval means and full plots.",
              "channels": {}}
    midpoint = (args.start + args.end) / 2
    first = compare_waveforms(native, reference, args.start, midpoint)
    second = compare_waveforms(native, reference, midpoint, args.end)
    for name in channels:
        row = statistics[name]
        for quantity, limit in (("mean", .05), ("amplitude", .10)):
            expected, actual = row[f"openfast_{quantity}"], row[f"native_{quantity}"]
            relative = abs(actual - expected) / abs(expected) if expected != 0 else 0. if actual == 0 else None
            row[f"passes_{quantity}"] = relative is not None and relative <= limit
            row[f"absolute_relative_{quantity}_difference"] = relative
        row["native_half_interval_means"] = [first[name]["native_mean"], second[name]["native_mean"]]
        row["openfast_half_interval_means"] = [first[name]["openfast_mean"], second[name]["openfast_mean"]]
        report["channels"][name] = row
    report["passed"] = all(row["passes_mean"] and row["passes_amplitude"] for row in report["channels"].values())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(report, indent=2, allow_nan=False))
    if not report["passed"]:
        raise SystemExit(1)
