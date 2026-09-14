"""Inspect the actual inline/binary local output after its recording ACKs."""
import json
import sys
from pathlib import Path

import numpy as np

root = Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
result = {key: manifest[key] for key in ["state", "durationMs", "sourceHash", "catalogRevision", "recordSequences", "visualizationSequences", "recordedBytes"]}
result["traceCount"] = len(manifest["trace"])
result["lastObservations"] = {item["task"]: item["observations"] for item in manifest["trace"]}
result["recordSummary"] = {}
for record in manifest["records"]:
    packet = json.loads((root / record["path"]).read_text(encoding="utf-8"))
    tensor = packet["value"]
    storage = tensor["storage"]
    if storage["kind"] == "inline":
        values = np.asarray(storage["value"], dtype=packet["schema"]["dtype"])
    else:
        attachments = {part["id"]: (root / part["path"]).read_bytes() for part in packet["attachments"]}
        values = np.frombuffer(b"".join(attachments[name] for name in storage["ids"]), dtype=packet["schema"]["dtype"])
    values = values.reshape(tensor["shape"])
    times = np.asarray(tensor["axes"][3]["ticks"])
    summary = {"shape": tensor["shape"], "unit": packet["schema"]["unit"], "timeCount": len(times),
               "firstTime": times[0], "lastTime": times[-1], "minimum": float(values.min()), "maximum": float(values.max()),
               "finite": bool(np.all(np.isfinite(values))), "uniqueTimes": len(np.unique(times)) == len(times)}
    if record["name"] == "pressureProbe" and len(times) == 2001:
        phase_time = times - .4 / 343
        exact = np.where((phase_time >= 0) & (phase_time <= .008),
                         1.2 * 343 * .001 * np.sin(2 * np.pi * 250 * phase_time) * np.sin(np.pi * phase_time / .008) ** 2, 0)
        summary["analyticRelativeL2"] = float(np.linalg.norm(values.reshape(-1) - exact) / np.linalg.norm(exact))
    result["recordSummary"][record["name"]] = summary
output = json.dumps(result, ensure_ascii=False, indent=2)
(root / "verified-summary.json").write_text(output, encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(output)
