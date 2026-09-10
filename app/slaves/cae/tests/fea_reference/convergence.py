"""같은 물리 입력에서 dt 또는 연성 구간만 바꾼 운전 파형을 비교한다.

비교 구간의 모든 공통 표본에서 최대 차이를 기준 파형의 최대 절댓값으로
나눈다. 0인 채널은 두 파형이 모두 0일 때만 상대 차이를 0으로 둔다.
평균만 우연히 같고 진동이 다른 경우를 통과시키지 않도록 파형 전체를 쓴다.
초기 과도/정상 운전 중 어느 구간을 검사했는지도 결과 파일에 명시한다.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--refined", required=True, type=Path)
    parser.add_argument("--start", required=True, type=float)
    parser.add_argument("--end", required=True, type=float)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    with np.load(args.baseline, allow_pickle=False) as data:
        baseline = dict(data)
    with np.load(args.refined, allow_pickle=False) as data:
        refined = dict(data)
    times = baseline["times"]
    for data in (baseline, refined):
        if data["times"].ndim != 1 or len(data["times"]) < 2 or any(
            value.shape != data["times"].shape or not np.all(np.isfinite(value))
            for value in data.values()
        ):
            raise ValueError("waveform channels require finite scalar samples at each time")
    if np.any(np.diff(times) <= 0) or np.any(np.diff(refined["times"]) <= 0):
        raise ValueError("both waveforms require increasing times")
    # 240 s 부근의 누적 덧셈 꼬리도 포함한다. 시간 값을 바꾸거나 응답 허용값을
    # 늘리는 것이 아니라 compare.py와 같은 구간 경계 선택 규칙을 적용한다.
    time_tolerance = 1e-12 * max(1., abs(args.start), abs(args.end))
    if args.start < max(times[0], refined["times"][0]) - time_tolerance or args.end > min(times[-1], refined["times"][-1]) + time_tolerance:
        raise ValueError("the complete requested interval must exist in both runs")
    selected = (times >= args.start - time_tolerance) & (times <= args.end + time_tolerance)
    if np.sum(selected) < 2:
        raise ValueError("comparison needs at least two baseline samples")
    channels = ("rotorSpeed", "pitch", "electricalPower", "bladeTipDeflectionX",
                "towerDisplacementX", "foundationForceX", "foundationMomentY")
    report = {"baseline_sha256": hashlib.sha256(args.baseline.read_bytes()).hexdigest(),
              "refined_sha256": hashlib.sha256(args.refined.read_bytes()).hexdigest(),
              "start": args.start, "end": args.end, "sample_count": int(np.sum(selected)),
              "criterion": "maximum waveform difference / baseline maximum absolute value <= 0.02",
              "channels": {}}
    for name in channels:
        if name not in baseline or name not in refined:
            raise ValueError(f"both runs must provide the requested channel {name}")
        first = baseline[name][selected]
        second = np.interp(times[selected], refined["times"], refined[name])
        scale = float(np.max(np.abs(first)))
        error = float(np.max(np.abs(second - first)))
        relative = error / scale if scale > 0 else 0. if error == 0 else None
        report["channels"][name] = {"maximum_absolute_difference": error,
                                    "baseline_maximum_absolute_value": scale,
                                    "relative_difference": relative,
                                    "passes_two_percent": relative is not None and relative <= .02}
    report["passed"] = all(row["passes_two_percent"] for row in report["channels"].values())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(1)
