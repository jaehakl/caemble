from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def main() -> None:
    if sys.argv[1:] and sys.argv[1] in {"prepare", "doctor", "smoke"}:
        from app.runtime import doctor, get_runtime, prepare

        parser = argparse.ArgumentParser(description="Prepare or verify the independent CPU TTS worker")
        parser.add_argument("command", choices=["prepare", "doctor", "smoke"])
        parser.add_argument("--output", type=Path, default=Path(".data/kokoro-smoke.wav"))
        args = parser.parse_args()
        try:
            if args.command == "prepare":
                result = prepare()
            elif args.command == "doctor":
                result = doctor()
            else:
                wav, result = get_runtime().synthesize("I am looking forward to learning English with you.")
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_bytes(wav)
                result = {"ready": True, "output": str(args.output.resolve()), "size": len(wav), **result}
            print(json.dumps(result, ensure_ascii=False))
        except Exception as error:
            print(json.dumps({"ready": False, "error": str(error)}, ensure_ascii=False))
            raise SystemExit(1) from None
    else:
        from sdk.slave import run_app
        from app.worker import create_app

        run_app(create_app())


if __name__ == "__main__":
    main()
