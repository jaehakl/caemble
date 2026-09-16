"""Pytest selection and controller-only progress reports, also usable without xdist."""

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from time import perf_counter

import pytest

from tests.selection import Selection, selected_item


_reporter = None
_deselected = set()


def pytest_addoption(parser):
    group = parser.getgroup("cae regression")
    group.addoption("--cae-suite", choices=("affected", "quick", "full"), default="full")
    group.addoption("--cae-selection")
    group.addoption("--cae-report")


def pytest_configure(config):
    global _reporter, _deselected
    _reporter, _deselected = None, set()
    directory = config.getoption("cae_report")
    if directory and not hasattr(config, "workerinput"):
        _reporter = ProgressReport(Path(directory), config.getoption("cae_suite"))


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    suite = config.getoption("cae_suite")
    selection, examples = None, {}
    if suite == "affected":
        payload = json.loads(Path(config.getoption("cae_selection")).read_text(encoding="utf-8"))
        for name in ("solvers", "patterns", "files", "actions"):
            payload[name] = set(payload[name])
        selection = Selection(**payload)
        if selection.solvers:
            from caemble_catalog import open_catalog

            with open_catalog() as catalog:
                rows, _ = catalog.list_experiments(limit=10000)
                for row in rows:
                    files = catalog.experiment(row["coordinate"])["sourceBundle"]["files"]
                    names = {name.replace("-", "_") for source in files.values() for name in
                             re.findall(r"\bkernel\s*:\s*\{\s*name\s*:\s*['\"]([^'\"]+)", source)}
                    examples[row["key"]] = names
    selected, rejected, reasons = [], [], {}
    for item in items:
        reason = (selected_item(item, selection, examples) if suite == "affected" else
                  "full CPU" if suite == "full" else
                  "CPU quick" if item.get_closest_marker("validation") is None else None)
        if reason:
            selected.append(item)
            reasons[item.nodeid] = reason
        else:
            rejected.append(item)
    items[:] = selected
    if rejected:
        config.hook.pytest_deselected(items=rejected)
    if hasattr(config, "workeroutput"):
        config.workeroutput["cae_reasons"] = reasons
    if _reporter:
        _reporter.collect(reasons)


def pytest_deselected(items):
    _deselected.update(item.nodeid for item in items)


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_node_collection_finished(node, ids):
    if _reporter:
        _reporter.collect(dict.fromkeys(ids, "worker selection"))


@pytest.hookimpl(optionalhook=True)
def pytest_testnodedown(node, error):
    if _reporter:
        output = getattr(node, "workeroutput", {})
        _reporter.deselected = max(_reporter.deselected, output.get("cae_deselected", 0))
        _reporter.reasons.update(output.get("cae_reasons", {}))
        if error:
            _reporter.event("worker_error", error=str(error))


def pytest_runtest_logstart(nodeid, location):
    if _reporter:
        _reporter.active[nodeid] = datetime.now(timezone.utc).isoformat()
        _reporter.event("started", nodeid=nodeid)


def pytest_runtest_logreport(report):
    if _reporter:
        entry = _reporter.results.setdefault(report.nodeid, {"phases": {}, "outcome": "passed"})
        entry["phases"][report.when] = report.duration
        if report.failed or (report.skipped and entry["outcome"] != "failed"):
            entry["outcome"] = report.outcome
        if report.when == "teardown":
            _reporter.active.pop(report.nodeid, None)
        _reporter.event("phase", nodeid=report.nodeid, phase=report.when,
                        duration=report.duration, outcome=report.outcome,
                        worker=getattr(report, "worker_id", "master"))


def pytest_sessionfinish(session, exitstatus):
    if hasattr(session.config, "workeroutput"):
        session.config.workeroutput["cae_deselected"] = len(_deselected)
    if _reporter:
        _reporter.deselected = max(_reporter.deselected, len(_deselected))
        _reporter.finish(int(exitstatus), session.config.option.collectonly)


class ProgressReport:
    def __init__(self, root, suite):
        self.root, self.suite = root, suite
        root.mkdir(parents=True, exist_ok=True)
        self.started = perf_counter()
        self.active, self.results, self.reasons = {}, {}, {}
        self.deselected = 0

    def collect(self, reasons):
        self.reasons.update(reasons)
        (self.root / "selected.json").write_text(json.dumps(self.reasons, indent=2), encoding="utf-8")

    def event(self, kind, **details):
        event = {"time": datetime.now(timezone.utc).isoformat(), "event": kind, **details}
        with (self.root / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event) + "\n")
        status = {"elapsed": perf_counter() - self.started, "active": self.active,
                  "completed": sum("teardown" in value["phases"] for value in self.results.values())}
        temporary = self.root / "status.tmp"
        try:
            temporary.write_text(json.dumps(status, indent=2), encoding="utf-8")
            temporary.replace(self.root / "status.json")
        except PermissionError:
            # Windows readers/virus scanners may briefly deny replacement. The
            # append-only event stream is authoritative; refresh on the next event.
            pass

    def finish(self, exitstatus, collected):
        self.collect(self.reasons)
        builds = [json.loads(path.read_text(encoding="utf-8")) for path in (self.root / "builds").glob("*/complete.json")]
        slowest = sorted(({"nodeid": key, "duration": sum(value["phases"].values()), **value}
                          for key, value in self.results.items()), key=lambda item: item["duration"], reverse=True)
        summary = {"suite": self.suite, "exitStatus": exitstatus, "collectionOnly": collected,
                   "elapsed": perf_counter() - self.started, "selected": len(self.reasons),
                   "deselected": self.deselected, "unfinished": self.active,
                   "outcomes": {kind: sum(value["outcome"] == kind and "teardown" in value["phases"] for value in self.results.values())
                                for kind in ("passed", "failed", "skipped")},
                   "buildCount": len(builds), "builds": builds, "slowest": slowest[:25]}
        (self.root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        self.event("finished", exitStatus=exitstatus)
