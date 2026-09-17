"""Run-local, locked CLI input builds. Solver results are never cached."""

from hashlib import sha256
import json
from pathlib import Path
import subprocess
from time import perf_counter
from uuid import uuid4

from caemble_catalog import open_catalog
from filelock import FileLock


class CatalogBuilds:
    def __init__(self, root: Path, repo: Path):
        from tests.cli_build_observer import install

        install()  # Spawned input-sharing helpers inherit the test event directory.
        self.root, self.repo = root, repo
        self.root.mkdir(parents=True, exist_ok=True)
        self.cli = repo / "app/ui/dist-cli/caemble.cjs"
        self.cli_hash = sha256(self.cli.read_bytes()).hexdigest()

    def measurement(self, example: str, variables: dict | None = None) -> dict:
        with open_catalog() as catalog:
            coordinate = catalog.experiment(example, include_bundle=False)["coordinate"]
            revision = catalog.meta()["catalogRevision"]
        identity = {"catalogRevision": revision, "example": coordinate,
                    "variables": variables, "cliHash": self.cli_hash}
        key = sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        directory = self.root / key
        # Shared by all xdist workers, scoped to this pytest run only.
        with FileLock(str(self.root / f"{key}.lock"), timeout=180):
            complete = directory / "complete.json"
            if not complete.exists():
                directory.mkdir(exist_ok=True)
                artifact = directory / ("artifact-" + uuid4().hex)
                arguments = ["node", str(self.cli), "--repo", str(self.repo), "experiment", "build",
                             "--example", coordinate, "--out", str(artifact)]
                if variables is None:
                    arguments.extend(("--vars-mode", "nominal"))
                else:
                    values = directory / "vars.json"
                    values.write_text(json.dumps(variables), encoding="utf-8")
                    arguments.extend(("--mode", "candidate", "--vars", str(values)))
                started = perf_counter()
                built = subprocess.run(arguments, cwd=self.repo, capture_output=True, text=True, encoding="utf-8")
                if built.returncode:
                    raise RuntimeError(f"Catalog build failed for {coordinate}:\n{built.stdout}\n{built.stderr}")
                manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
                if len(manifest["items"]) != 1 or manifest["catalog_revision"] != revision:
                    raise ValueError("Catalog build must contain one measurement at the current revision")
                item = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
                (directory / "measurement.json").write_text(json.dumps(item["measurement"]), encoding="utf-8")
                ready = directory / "complete.tmp"
                ready.write_text(json.dumps({**identity, "duration": perf_counter() - started}), encoding="utf-8")
                ready.replace(complete)
            # Fresh decoding prevents a test's mutable observation/model edits leaking.
            return json.loads((directory / "measurement.json").read_text(encoding="utf-8"))

    def __getitem__(self, example: str) -> dict:
        """Keep existing catalog_builds[key] tests lazy and independently owned."""
        return self.measurement(example)
