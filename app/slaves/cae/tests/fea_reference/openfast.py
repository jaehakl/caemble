"""외부 기준해를 내려받고 실행하는 개발용 도구. Solver 런타임에서는 사용하지 않는다.

원본 파일과 수정본을 분리하고, 모든 입력 변경·hash·실행 종료 코드를 기록한다.
터빈 계수를 구현 코드에 복제하지 않고 고정된 공식 r-test 원본을 사용한다.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[5]
REVISION = "dd5feaaaa500ba7283140107806300d551cff0a7"
RELEASE = "v5.0.0"
CASE_FILE = "5MW_OC3Mnpl_DLL_WTurb_WavesIrr.fst"
SOURCE_CASE = "5MW_OC3Mnpl_DLL_WTurb_WavesIrr"
EXECUTABLE_HASHES = {
    "OpenFAST_Double_Release.exe": "f947198a7dff813a9f221a22a29fd451d40a51a5e976d1847900f1c890d7ffc7",
    "DISCON.dll": "a2501ada8494c665c3a2ae6aa287a646dd2465ce4ab8c751998a47cf6a9ba548",
}
# 독립 검증 프로토콜의 풍속/초기 상태다. Solver의 기본값이나 Catalog 정의가 아니다.
OPERATING_CASES = [
    ("08", 8.0, 9.0, 0.0),
    ("11p4", 11.4, 12.1, 0.0),
    ("18", 18.0, 12.1, 12.0),
]
SUITES = {
    "original": "wind",
    "aligned": "aligned",
    "rigid": "rigid",
    "offsetrigid": "offsetrigid",
    "stationary": "stationary",
    "fixedhydro": "fixedhydro",
    "ramp": "ramp",
}


def suite_cases(suite):
    if suite in ("stationary", "fixedhydro"):
        return [("", 0., 0., 0.)]
    if suite == "ramp":
        return [("", *OPERATING_CASES[1][1:])]
    return OPERATING_CASES


def download(directory):
    directory.mkdir(parents=True, exist_ok=True)
    tree_url = (
        f"https://api.github.com/repos/OpenFAST/r-test/git/trees/{REVISION}?recursive=1"
    )
    tree = json.loads(urllib.request.urlopen(tree_url, timeout=60).read())
    (directory / "tree.json").write_text(json.dumps(tree, indent=2), encoding="utf-8")
    prefix = "glue-codes/openfast/"
    requests = []
    for item in tree["tree"]:
        name = item["path"]
        if item["type"] != "blob" or not any(
            name.startswith(prefix + folder + "/")
            for folder in ["5MW_Baseline", SOURCE_CASE]
        ):
            continue
        if any(part in name for part in ["/Wind/", "/HydroData/", "/ServoData/"]):
            continue
        if Path(name).suffix in [".bts", ".wnd", ".outb", ".out", ".sum"]:
            continue
        requests.append(
            (
                f"https://raw.githubusercontent.com/OpenFAST/r-test/{REVISION}/{name}",
                directory / "source" / name.removeprefix(prefix),
            )
        )
    requests.append(
        (
            f"https://raw.githubusercontent.com/OpenFAST/r-test/{REVISION}/LICENSE",
            directory / "source/LICENSE",
        )
    )
    for name in EXECUTABLE_HASHES:
        requests.append(
            (
                f"https://github.com/OpenFAST/openfast/releases/download/{RELEASE}/{name}",
                directory / "bin" / name,
            )
        )

    def fetch(request):
        url, path = request
        path.parent.mkdir(parents=True, exist_ok=True)
        data = urllib.request.urlopen(url, timeout=120).read()
        digest = hashlib.sha256(data).hexdigest()
        if path.name in EXECUTABLE_HASHES and digest != EXECUTABLE_HASHES[path.name]:
            raise ValueError(
                f"Released executable hash changed: {path.name}; refusing to execute"
            )
        path.write_bytes(data)
        return {
            "url": url,
            "path": str(path.relative_to(directory)),
            "size": len(data),
            "sha256": digest,
        }

    with ThreadPoolExecutor(max_workers=8) as executor:
        files = list(executor.map(fetch, requests))
    (directory / "download_manifest.json").write_text(
        json.dumps(
            {"openfast_release": RELEASE, "r_test_commit": REVISION, "files": files},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Fetched and hashed {len(files)} official files in {directory}")


def prepare(directory, suite, duration, initial_state="source"):
    source, model = directory / "source", directory / "model"
    is_rigid = suite in ["rigid", "offsetrigid"]
    is_stationary, is_hydro = suite == "stationary", suite == "fixedhydro"
    default_duration = {"stationary": .01, "fixedhydro": 16., "rigid": 2.,
                        "offsetrigid": 2., "ramp": 40.}.get(suite, 300.)
    duration = default_duration if duration is None else duration
    common_name = (
        "5MW_AlignedBaseline" if suite in ["aligned", "rigid"] else "5MW_Baseline"
    )
    if suite == "ramp":
        common_name = "5MW_RampBaseline"
    if initial_state == "unstrained":
        common_name = common_name.replace("Baseline", "UnstrainedBaseline")
    common = model / common_name
    shutil.copytree(source / "5MW_Baseline", common, dirs_exist_ok=True)
    (common / "ServoData").mkdir(exist_ok=True)
    shutil.copy2(directory / "bin/DISCON.dll", common / "ServoData/DISCON.dll")
    changes = []
    if suite in ["aligned", "rigid"]:
        blade = common / "NRELOffshrBsline5MW_AeroDyn_blade.dat"
        lines = blade.read_text(encoding="utf-8").splitlines()
        count = int(next(line.split()[0] for line in lines if "NumBlNds" in line))
        start = (
            next(i for i, line in enumerate(lines) if line.strip().startswith("(m)"))
            + 1
        )
        for index in range(start, start + count):
            columns = lines[index].split()
            columns[1:3] = ["0.0", "0.0"]
            lines[index] = " ".join(columns)
        blade.write_text("\n".join(lines) + "\n", encoding="utf-8")
        changes.append(
            {
                "file": str(blade.relative_to(directory)),
                "change": "BlCrvAC and BlSwpAC set to zero for diagnostic only",
            }
        )

    def replace(path, settings):
        text = path.read_text(encoding="utf-8")
        for label, value in settings.items():
            # LinTimes처럼 값이 쉼표 목록인 입력도 label 앞의 값 전체를 바꾼다.
            pattern = rf'^([ \t]*)[^\r\n]*?([ \t]+{re.escape(label)})(?=[ \t]+-)'
            text, count = re.subn(
                pattern,
                lambda match, value=value: f"{match[1]}{value}{match[2]}",
                text,
                flags=re.MULTILINE,
            )
            if count != 1:
                raise ValueError(f"{path.name}: expected one {label}, found {count}")
            changes.append(
                {
                    "file": str(path.relative_to(directory)),
                    "label": label,
                    "value": value,
                }
            )
        path.write_text(text, encoding="utf-8")

    if initial_state == "unstrained":
        replace(common / "NRELOffshrBsline5MW_BeamDyn.dat", {"QuasiStaticInit": "False"})

    for suffix, wind, rpm, pitch in suite_cases(suite):
        case = model / (SUITES[suite] + suffix)
        case.mkdir(parents=True, exist_ok=True)
        for path in (source / SOURCE_CASE).iterdir():
            if path.suffix in [".dat", ".fst"]:
                text = path.read_text(encoding="utf-8").replace(
                    "../5MW_Baseline/", f"../{common_name}/"
                )
                (case / path.name).write_text(text, encoding="utf-8")
        replace(
            case / CASE_FILE,
            {
                "TMax": duration,
                "DT": 0.005,
                "DT_Out": 0.005,
                "OutFileFmt": 1,
                "SttsTime": 10,
                "CompElast": 1 if is_rigid or is_hydro else 2,
                "Gravity": 9.81,
                "WtrDens": 1025,
                "WtrDpth": 20.0001,
                "InflowFile": '"InflowWind.dat"',
            },
        )
        elastic_settings = {
            "ShftTilt": 0,
            "PreCone(1)": 0,
            "PreCone(2)": 0,
            "PreCone(3)": 0,
            "NacYaw": 0,
            "YawDOF": "False",
            "Azimuth": 0,
            "RotSpeed": rpm,
            "BlPitch(1)": pitch,
            "BlPitch(2)": pitch,
            "BlPitch(3)": pitch,
        }
        if initial_state == "unstrained":
            elastic_settings["PtfmHeave"] = 0
        if is_rigid:
            # 원래 결합 실행의 마지막 구간 평균 운전점에서 공력 알고리즘만 비교한다.
            report = json.loads(
                (model / ("wind" + suffix) / "reference_analysis.json").read_text(
                    encoding="utf-8"
                )
            )
            mean_speed = report["statistics"]["rotorSpeed"]["mean"]
            mean_pitch = report["statistics"]["pitch"]["mean"]
            elastic_settings.update(
                {"RotSpeed": mean_speed * 30 / 3.141592653589793, "PtfmHeave": 0}
            )
            for blade in range(1, 4):
                elastic_settings[f"BlPitch({blade})"] = (
                    mean_pitch * 180 / 3.141592653589793
                )
        if is_rigid or is_hydro:
            elastic_settings["PtfmHeave"] = 0
            for name in [
                "FlapDOF1",
                "FlapDOF2",
                "EdgeDOF",
                "PitchDOF",
                "TeetDOF",
                "DrTrDOF",
                "GenDOF",
                "TwFADOF1",
                "TwFADOF2",
                "TwSSDOF1",
                "TwSSDOF2",
                "PtfmSgDOF",
                "PtfmSwDOF",
                "PtfmHvDOF",
                "PtfmRDOF",
                "PtfmPDOF",
                "PtfmYDOF",
            ]:
                elastic_settings[name] = "False"
            module_settings = {"CompServo": 0, "CompHydro": 0, "CompSeaSt": 0, "CompSub": 0}
            if is_hydro:
                module_settings.update(CompHydro=1, CompSeaSt=1, CompAero=0, CompInflow=0)
            replace(case / CASE_FILE, module_settings)
        if is_stationary:
            elastic_settings.update(RotSpeed=0, GenDOF="False", PtfmHeave=0)
            replace(case / CASE_FILE, {
                "CompInflow": 0, "CompAero": 0, "CompServo": 0, "CompSeaSt": 0,
                "CompHydro": 0, "Gravity": 0, "Linearize": "True", "CalcSteady": "False",
                "NLinTimes": 1, "LinTimes": 0, "LinInputs": 0, "LinOutputs": 0,
                "LinOutJac": "False", "LinOutMod": "False",
            })
        replace(
            case / "NRELOffshrBsline5MW_OC3Monopile_ElastoDyn.dat", elastic_settings
        )
        elastic_file = case / "NRELOffshrBsline5MW_OC3Monopile_ElastoDyn.dat"
        lines = elastic_file.read_text(encoding="utf-8").splitlines()
        output_start = next(i for i, line in enumerate(lines) if line.split()[:1] == ["OutList"])
        # TwHt1TPxi는 TwrGagNd의 중간 절점(이 사례는85.66m) 위치다.
        # 실제 타워 꼭대기87.6m의 global 변위는 별도 채널로 요청한다.
        lines.insert(output_start + 1, '"TwrTpTDxi"')
        elastic_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        changes.append({"file": str(elastic_file.relative_to(directory)), "change": "added TwrTpTDxi true tower-top displacement output"})
        aerodynamic_file = case / "NRELOffshrBsline5MW_OC3Monopile_AeroDyn.dat"
        replace(
            aerodynamic_file,
            {
                "TwrPotent": 0,
                "TwrShadow": 0,
                "TwrAero": "False",
                "Skew_Mod": 0,
                "AIDrag": "True",
                "TIDrag": "True",
                "DBEMT_Mod": 0 if is_rigid else 2,
                "UA_Mod": 0,
                "AoA34": "False",
            },
        )
        if is_rigid:
            text = aerodynamic_file.read_text(encoding="utf-8")
            before, after = text.split("OutList_Nodal", 1)
            comment, remainder = after.split("\n", 1)
            aerodynamic_file.write_text(
                before
                + "OutList_Nodal"
                + comment
                + '\n"Fn, Ft, Alpha, AxInd, Phi"\n'
                + remainder,
                encoding="utf-8",
            )
        shutil.copy2(
            common / "NRELOffshrBsline5MW_InflowWind_Steady8mps.dat",
            case / "InflowWind.dat",
        )
        replace(
            case / "InflowWind.dat", {"WindType": 1, "HWindSpeed": wind, "PLExp": 0}
        )
        if suite == "ramp":
            # 공식 uniform wind의 8개 열을 사용한다. 풍속 외의 방향·수직풍·
            # 전단·gust는 0이다. 30→35초 사이를 선형 보간하므로 native의
            # 명시적 windTimes/velocities 파형과 같은 입력이 된다.
            ramp_file = case / "UniformRamp.wnd"
            ramp_times = [0., 30., 35., max(120., duration)]
            ramp_speeds = [wind, wind, wind + 1., wind + 1.]
            ramp_file.write_text(
                "! Time Vh_ref Direction VZ HLinShr VShr VLinShr VGust\n"
                + "\n".join(f"{t:g} {speed:g} 0 0 0 0 0 0"
                            for t, speed in zip(ramp_times, ramp_speeds, strict=True))
                + "\n", encoding="utf-8",
            )
            changes.append({"file": str(ramp_file.relative_to(directory)),
                            "change": "uniform linear ramp; all shear/gust/direction columns zero",
                            "times": ramp_times, "speeds": ramp_speeds})
            replace(case / "InflowWind.dat", {
                "WindType": 2, "FileName_Uni": '"UniformRamp.wnd"', "VelInterpCubic": "False",
            })
        replace(
            case / "SeaState.dat",
            {
                "WaveMod": "1P0",
                "WaveHs": 2,
                "WaveTp": 8,
                "WaveDir": 0,
                "WaveTMax": max(600, duration),
                "WaveDT": 0.005,
                "WaveStMod": 0,
                "WvCrntMod": 0,
                "WvDiffQTF": "False",
                "WvSumQTF": "False",
                "CurrMod": 1,
                "CurrSSV0": 0,
                "CurrNSV0": 0,
                "CurrDIV": 0.2,
                "CurrDIDir": 0,
            },
        )
        replace(
            case / "NRELOffshrBsline5MW_OC3Monopile_HydroDyn.dat",
            {"WaveDisp": 0, "AMMod": 0, "HstMod": 0},
        )
    files = []
    for folder in [common] + [
        model / (SUITES[suite] + suffix) for suffix, *_ in suite_cases(suite)
    ]:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and path.suffix in [".dat", ".fst", ".dll", ".txt", ".wnd"]:
                files.append(
                    {
                        "path": str(path.relative_to(directory)),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                )
    (directory / f"{suite}_settings.json").write_text(
        json.dumps(
            {
                "release": RELEASE,
                "revision": REVISION,
                "suite": suite,
                "duration": duration,
                "initial_state": initial_state,
                "baseline_folder": common_name,
                "changes": changes,
                "input_hashes": files,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Prepared {suite} suite; settings and hashes recorded")


def verify_prepared_inputs(directory, suite):
    """실행할 파일이 준비 당시의 입력과 같은지 확인하고 증거를 반환한다.

    settings를 저장했다는 사실만으로 이후 파일 변경을 막을 수는 없다. 모든
    입력을 실행 직전에 다시 읽어 비교하며, 불일치는 외부 프로그램 실행 전에
    실패시킨다. 이 검사를 과거 실행에 소급 적용한 것처럼 기록하지 않는다.
    """
    settings_path = directory / f"{suite}_settings.json"
    settings_bytes = settings_path.read_bytes()
    settings = json.loads(settings_bytes)
    inputs = settings.get("input_hashes", [])
    if settings.get("suite") != suite or not inputs:
        raise ValueError("Prepared settings must identify the suite and its input hashes")
    for item in inputs:
        path = directory / item["path"]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"Prepared input checksum mismatch: {item['path']}; refusing to execute")
    return settings, {
        "settings_sha256": hashlib.sha256(settings_bytes).hexdigest(),
        "verified_input_count": len(inputs),
        "input_hash_verification": "verified immediately before launching this suite",
    }


def run(directory, suite, workers):
    settings, verification = verify_prepared_inputs(directory, suite)
    for filename, expected in EXECUTABLE_HASHES.items():
        if (
            hashlib.sha256((directory / "bin" / filename).read_bytes()).hexdigest()
            != expected
        ):
            raise ValueError(f"Executable checksum mismatch: {filename}")
    common_name = settings["baseline_folder"]
    controller = directory / "model" / common_name / "ServoData/DISCON.dll"
    if (
        hashlib.sha256(controller.read_bytes()).hexdigest()
        != EXECUTABLE_HASHES["DISCON.dll"]
    ):
        raise ValueError(
            "The controller actually loaded by the case has a different checksum"
        )

    def execute(operating_case):
        suffix, *_ = operating_case
        case = directory / "model" / (SUITES[suite] + suffix)
        started = time.perf_counter()
        with (
            (case / "stdout.log").open("w", encoding="utf-8") as stdout,
            (case / "stderr.log").open("w", encoding="utf-8") as stderr,
        ):
            process = subprocess.run(
                [str(directory / "bin/OpenFAST_Double_Release.exe"), CASE_FILE],
                cwd=case,
                stdout=stdout,
                stderr=stderr,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        normal = "OpenFAST terminated normally." in (case / "stdout.log").read_text(
            encoding="utf-8", errors="replace"
        )
        result = {
            "case": case.name,
            "exit_code": process.returncode,
            "normal_termination": normal,
            "wall_seconds": time.perf_counter() - started,
            **verification,
        }
        (case / "execution.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )
        print(json.dumps(result), flush=True)
        if process.returncode or not normal:
            raise RuntimeError(
                f"OpenFAST failed in {case}; inspect stdout.log and stderr.log"
            )
        return result

    with ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(execute, suite_cases(suite)))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["download", "prepare", "run"])
    parser.add_argument(
        "--directory", type=Path, default=REPOSITORY / ".work/openfast-reference"
    )
    parser.add_argument("--suite", choices=SUITES, default="original")
    parser.add_argument("--duration", type=float)
    parser.add_argument("--initial-state", choices=["source", "unstrained"], default="source",
                        help="prepare only: preserve source preconditioning, or start BeamDyn unstrained with platform heave zero")
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.action == "download":
        download(directory)
    elif args.action == "prepare":
        prepare(directory, args.suite, args.duration, args.initial_state)
    else:
        run(directory, args.suite, args.workers)
