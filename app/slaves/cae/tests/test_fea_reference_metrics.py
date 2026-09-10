"""비교 구간·시간 가중 평균·진폭의 정의를 해석 가능한 작은 파형으로 확인한다."""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tests.fea_reference.compare import CASE_FILE, CHANNELS, compare_waveforms


def test_comparison_includes_accumulated_time_roundoff_at_both_boundaries():
    times = np.asarray([239.99999999985, 270., 300.00000000015])
    reference = {"times": np.asarray([240., 270., 300.]), "rotorSpeed": np.ones(3)}
    actual = {"times": times, "rotorSpeed": np.ones(3)}
    row = compare_waveforms(actual, reference, 240., 300.)["rotorSpeed"]
    assert row["sample_count"] == 3
    assert row["native_mean"] == pytest.approx(1.)
    assert row["rms_difference"] == 0.


def test_comparison_time_weights_irregular_samples_and_preserves_amplitude_error():
    # Piecewise-linear reference integral: .1*(0+.1)/2 + .9*(.1+1)/2 = .5.
    times = np.asarray([0., .1, 1.])
    reference = {"times": times, "rotorSpeed": times}
    actual = {"times": times, "rotorSpeed": 1.2 * times}
    row = compare_waveforms(actual, reference, 0., 1.)["rotorSpeed"]
    assert row["openfast_mean"] == pytest.approx(.5)
    assert row["native_mean"] == pytest.approx(.6)
    assert row["mean_relative_difference"] == pytest.approx(.2)
    assert row["amplitude_relative_difference"] == pytest.approx(.2)
    assert row["openfast_amplitude"] == pytest.approx(.5)


@pytest.mark.parametrize("invalid", [np.nan, np.inf])
def test_comparison_rejects_nonfinite_responses(invalid):
    reference = {"times": np.asarray([0., 1.]), "rotorSpeed": np.ones(2)}
    actual = {"times": reference["times"], "rotorSpeed": np.asarray([1., invalid])}
    with pytest.raises(ValueError, match="nonfinite"):
        compare_waveforms(actual, reference, 0., 1.)


@pytest.mark.parametrize("invalid", [False, True])
def test_convergence_cli_checks_a_late_checkpoint_waveform(tmp_path, invalid):
    times = np.asarray([239.999999999835, 244., 247.999999999828])
    names = ("rotorSpeed", "pitch", "electricalPower", "bladeTipDeflectionX",
             "towerDisplacementX", "foundationForceX", "foundationMomentY")
    values = {name: np.ones(3) for name in names}
    np.savez(tmp_path / "baseline.npz", times=times, **values)
    values["rotorSpeed"][1] = np.nan if invalid else 1.01
    np.savez(tmp_path / "refined.npz", times=times, **values)
    output = tmp_path / "comparison.json"
    completed = subprocess.run([
        sys.executable, str(Path(__file__).parent / "fea_reference" / "convergence.py"),
        "--baseline", str(tmp_path / "baseline.npz"),
        "--refined", str(tmp_path / "refined.npz"),
        "--start", "240", "--end", "248", "--out", str(output),
    ], capture_output=True, text=True, check=False)
    if invalid:
        assert completed.returncode != 0
        assert "finite scalar samples" in completed.stderr
        assert not output.exists()
    else:
        assert completed.returncode == 0, completed.stderr
        result = json.loads(output.read_text(encoding="utf-8"))
        assert result["sample_count"] == 3
        assert result["passed"]
        assert result["channels"]["rotorSpeed"]["relative_difference"] == pytest.approx(.01)


@pytest.mark.parametrize("case", ["equal", "mean", "amplitude", "zero", "changed_source", "missing_source"])
def test_qualification_cli_preserves_fixed_accuracy_and_provenance_criteria(tmp_path, case):
    # 실제 프로그램 결과를 흉내 낸 작은 파일로 판정 도구 자체를 검사합니다.
    # 이 시험의 통과는 터빈 정확도의 증거가 아닙니다. 평균과 진폭은 독립적으로
    # 틀릴 수 있으며, 기준값이 0일 때 임의의 분모로 오차를 숨기면 안 됩니다.
    names = ("rotorSpeed", "pitch", "electricalPower", "bladeTipDeflectionX",
             "towerDisplacementX", "foundationForceX", "foundationMomentY")
    times = np.arange(12001) * .005
    oscillation = np.sin(2 * np.pi * times / 10)
    reference = {name: 10 + oscillation for name in names}
    reference["pitch"] = np.zeros_like(times)
    actual = {name: values.copy() for name, values in reference.items()}
    if case == "mean":
        actual["rotorSpeed"] += .6
    elif case == "amplitude":
        actual["rotorSpeed"] = 10 + 1.11 * oscillation
    elif case == "zero":
        actual["pitch"] += 1e-12
    np.savez(tmp_path / "comparison_si.npz", times=times, **actual)
    (tmp_path / "report.json").write_text(json.dumps({
        "status": {"kind": "complete"}, "execution": "synthetic qualification-tool test",
        "sourceFilesChangedDuringRun": None if case == "missing_source" else case == "changed_source",
    }), encoding="utf-8")
    (tmp_path / "execution.json").write_text(json.dumps({
        "exit_code": 0, "normal_termination": True,
    }), encoding="utf-8")
    columns = ["Time"] + [CHANNELS[name][0] for name in names]
    values = np.column_stack([times] + [reference[name] / CHANNELS[name][1] for name in names])
    np.savetxt(tmp_path / Path(CASE_FILE).with_suffix(".out"), values,
               header=" ".join(columns) + "\nunits", comments="", fmt="%.16e")
    output = tmp_path / "qualification.json"
    completed = subprocess.run([
        sys.executable, str(Path(__file__).parent / "fea_reference" / "qualify.py"),
        "--native-run", str(tmp_path), "--reference-case", str(tmp_path),
        "--start", "0", "--end", "60", "--out", str(output),
    ], capture_output=True, text=True, check=False)
    if case in ("changed_source", "missing_source"):
        assert completed.returncode != 0
        assert "Solver sources stayed unchanged" in completed.stderr
        assert not output.exists()
        return
    assert completed.returncode == (0 if case == "equal" else 1), completed.stderr
    result = json.loads(output.read_text(encoding="utf-8"))
    assert result["passed"] == (case == "equal")
    if case == "mean":
        assert not result["channels"]["rotorSpeed"]["passes_mean"]
        assert result["channels"]["rotorSpeed"]["passes_amplitude"]
    elif case == "amplitude":
        assert result["channels"]["rotorSpeed"]["passes_mean"]
        assert not result["channels"]["rotorSpeed"]["passes_amplitude"]
    elif case == "zero":
        assert result["channels"]["pitch"]["absolute_relative_mean_difference"] is None
