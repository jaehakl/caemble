"""Exercise the shipped release without npm or an installed dist directory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile


REPO = Path(__file__).resolve().parents[4]


def test_release_bootstraps_cli_and_keeps_node_out_of_the_web_root(tmp_path):
    checkout = tmp_path / "새 checkout"
    deployment = checkout / "deployment"
    deployment.mkdir(parents=True)
    shutil.copyfile(REPO / "deployment/caemble.tar.gz", deployment / "caemble.tar.gz")
    scripts = checkout / "shared/execution/scripts"
    scripts.mkdir(parents=True)
    for name in ("node_runtime.py", "cli-bootstrap.cjs"):
        shutil.copyfile(REPO / "shared/execution/scripts" / name, scripts / name)
    for name in ("caemble", "caemble.cmd"):
        shutil.copyfile(REPO / name, checkout / name)
    cae = checkout / "app/slaves/cae_simulation"
    cae.mkdir(parents=True)
    (cae / "pyproject.toml").write_text("", encoding="utf-8")
    environment = {**os.environ, "CAEMBLE_PYTHON": sys.executable}
    wrapper = [str(checkout / "caemble.cmd")] if os.name == "nt" else ["sh", str(checkout / "caemble")]
    result = subprocess.run([*wrapper, "--help"], cwd=checkout, env=environment,
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    assert "optimization create" in result.stdout
    selected = (checkout / ".data/node-runtime/current").read_text()
    runtime = checkout / ".data/node-runtime" / selected
    modified = (runtime / "worker.cjs").stat().st_mtime_ns
    (checkout / "calculation.js").write_text(
        'export default function calculation(input) { console.log("한글"); '
        'return { dtype: "float64", data: [[1, 2], [3, 4]] }; }', encoding="utf-8")
    (checkout / "input.json").write_text("{}", encoding="utf-8")
    result = subprocess.run([*wrapper, "--json", "calculation", "run", "calculation.js", "--fixture", "input.json"],
                            cwd=checkout, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr + result.stdout
    assert json.loads(result.stdout)["output"]["shape"] == [2, 2]
    assert "한글" in result.stderr
    assert (runtime / "worker.cjs").stat().st_mtime_ns == modified
    assert not (checkout / "app/ui/dist-cli").exists()
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("sh"))
    if bash.is_file():
        result = subprocess.run([str(bash), str(checkout / "caemble").replace("\\", "/"), "--help"],
                                cwd=checkout, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=30)
        assert result.returncode == 0, result.stderr
        assert "optimization create" in result.stdout
    public = tmp_path / "public"
    public.mkdir()
    archive = deployment / "caemble.tar.gz"
    with tarfile.open(archive, "r:gz") as bundle:
        names = {entry.name for entry in bundle.getmembers() if entry.isfile()}
        assert "node/worker.cjs" in names and "node/caemble.cjs" in names
        assert not any(name.endswith("evaluation.cjs") for name in names)
    subprocess.run(["tar", "-xzf", str(archive), "-C", str(public), "--strip-components=1", "web"], check=True)
    assert (public / "index.html").is_file()
    assert (public / "runner.html").is_file()
    assert not list(public.rglob("*.cjs"))
    assert not list(public.rglob("*.d.ts"))
