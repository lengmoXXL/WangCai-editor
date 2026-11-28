import fcntl
import os
import signal
import sys
from contextlib import suppress


def resume(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, resume)
pid = int(sys.argv[2])
with open(sys.argv[1], "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        os.kill(pid, signal.SIGSTOP)
        # A closed pipe at either end means the test worker exited before teardown.
        with suppress(BrokenPipeError):
            os.write(sys.stdout.fileno(), b"paused\n")
            sys.stdin.buffer.read()
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
    finally:
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGCONT)
