"""POSIX process-group guardian; EOF of the launcher lifeline kills the group."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading


def main() -> None:
    lifeline = int(sys.argv[1])
    os.set_inheritable(lifeline, False)
    os.sched_setaffinity(0, [int(value) for value in sys.argv[2].split(",")])

    def watch_launcher() -> None:
        try:
            while os.read(lifeline, 1):
                pass
        finally:
            os.killpg(os.getpgrp(), signal.SIGKILL)

    threading.Thread(target=watch_launcher, daemon=True).start()
    child = subprocess.Popen(sys.argv[3:], close_fds=True)
    child.wait()
    # The group still owns any descendants left behind by the application.
    os.killpg(os.getpgrp(), signal.SIGKILL)


if __name__ == "__main__":
    main()
