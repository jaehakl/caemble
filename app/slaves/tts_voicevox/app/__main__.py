from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import statistics
import struct
import sys
import time
import wave

from app.settings import settings


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    command = sys.argv[1] if sys.argv[1:] else None
    # Linux resolves transitive CUDA dependencies at process startup, before dlopen.
    if command != "doctor" and sys.platform.startswith("linux"):
        directory = settings.resolve_app_path(settings.voicevox_runtime_dir)
        directories = sorted({str(path.parent) for path in directory.rglob("*.so*")})
        existing = os.environ.get("LD_LIBRARY_PATH", "").split(":")
        missing = [path for path in directories if path not in existing]
        if missing:
            environment = dict(os.environ, LD_LIBRARY_PATH=":".join(missing + [p for p in existing if p]))
            os.execve(sys.executable, [sys.executable, "-m", "app", *sys.argv[1:]], environment)
    if command not in ("doctor", "smoke"):
        from sdk.slave import run_app
        from app.worker import create_app

        run_app(create_app())
        return

    from app.runtime import close_voicevox_runtime, doctor, get_voicevox_runtime

    parser = argparse.ArgumentParser(description="Verify the independent VOICEVOX worker")
    parser.add_argument("command", choices=("doctor", "smoke"))
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--speaker", type=int, default=3)
    parser.add_argument("--text", default="こんにちは。今日は音声合成の動作を確認しています。")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "doctor":
            result = doctor()
        else:
            started = time.perf_counter()
            runtime = get_voicevox_runtime(args.device)
            initialization = time.perf_counter() - started
            query_started = time.perf_counter()
            query = runtime.create_audio_query(args.text, args.speaker)
            query_seconds = time.perf_counter() - query_started
            runtime.synthesis(query, args.speaker)  # Warmup is excluded from measurements.
            timings = []
            for _ in range(3):
                started = time.perf_counter()
                wav = runtime.synthesis(query, args.speaker)
                timings.append(time.perf_counter() - started)
            with wave.open(io.BytesIO(wav), "rb") as stream:
                if stream.getsampwidth() != 2 or stream.getnframes() == 0:
                    raise RuntimeError("VOICEVOX produced invalid PCM16 WAV")
                duration = stream.getnframes() / stream.getframerate()
                samples = struct.iter_unpack("<h", stream.readframes(stream.getnframes()))
                peak = max(abs(sample[0]) for sample in samples)
                if peak == 0:
                    raise RuntimeError("VOICEVOX produced silent speech")
            output = args.output or Path(f".data/voicevox-{args.device}-smoke.wav")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(wav)
            result = {"ready": True, "device": runtime.device, "is_gpu_mode": runtime.is_gpu_mode,
                      "initialization_seconds": initialization, "audio_query_seconds": query_seconds,
                      "synthesis_seconds": timings, "median_seconds": statistics.median(timings),
                      "duration_seconds": duration, "peak": peak, "speaker": args.speaker,
                      "text": args.text, "output": str(output.resolve()), "size": len(wav)}
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1) from None
    finally:
        close_voicevox_runtime()


if __name__ == "__main__":
    main()
