"""저장된 SI 파형을 같은 축에 그린다. Matplotlib은 검증 도구의 선택 의존성이다.

그림은 오차 허용값이나 정상상태 판정을 대신하지 않는다. 시작/끝 시간을 직접
지정하고, 비교 가능한 실제 표본만 표시한다. 원시 결과 배열은 수정하지 않는다.
"""

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--title", default="Coupled turbine response")
    args = parser.parse_args()
    native, reference = np.load(args.native), np.load(args.reference)
    channels = [
        ("rotorSpeed", 30 / np.pi, "Rotor speed [rpm]"),
        ("pitch", 180 / np.pi, "Collective pitch [deg]"),
        ("electricalPower", 1e-6, "Electrical power [MW]"),
        ("bladeTipDeflectionX", 1., "Blade-tip flap deflection [m]"),
        ("towerDisplacementX", 1., "Tower-top X displacement [m]"),
        ("foundationMomentY", 1e-6, "Foundation support moment Y [MN m]"),
        ("hydrodynamicForceX", 1e-3, "Total hydrodynamic force X [kN]"),
        ("foundationForceX", 1e-3, "Foundation support force X [kN]"),
    ]
    figure, axes = plt.subplots(4, 2, figsize=(13, 12), sharex=True,
                                layout="constrained")
    time_tolerance = 1e-12 * max(1., abs(args.start), abs(args.end))
    for axis, (name, scale, label) in zip(axes.flat, channels, strict=True):
        for data, legend, color, style in (
            (reference, "OpenFAST 5.0.0", "#727983", "-"),
            (native, "Native FEA", "#006aa7", "--"),
        ):
            times = data["times"]
            if name not in data or data[name].shape != times.shape:
                raise ValueError(f"Missing scalar waveform: {legend} {name}")
            keep = (times >= args.start - time_tolerance) & (times <= args.end + time_tolerance)
            if np.count_nonzero(keep) < 2:
                raise ValueError(f"Requested interval has fewer than two samples: {legend}")
            axis.plot(times[keep], data[name][keep] * scale, label=legend,
                      color=color, linestyle=style, linewidth=1.35)
        axis.set_ylabel(label)
        axis.grid(alpha=.22)
        axis.set_xlim(args.start, args.end)
    axes[0, 0].legend(frameon=False)
    for axis in axes[-1]:
        axis.set_xlabel("Time [s]")
    figure.suptitle(args.title)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.out, dpi=180)
    plt.close(figure)
