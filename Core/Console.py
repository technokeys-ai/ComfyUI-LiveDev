"""The console tee: what the server prints, also sent to the browser.

Its own module because it is the only part of the pack that replaces `sys.stdout`, and that side
effect should be visible in one place rather than buried among routes.
"""

import io
import sys
import time

from server import PromptServer

from . import State

_CONSOLE_INSTALLED: bool = False


class _ConsoleTee(io.TextIOBase):
    """Tees server stdout/stderr into the in-memory buffer and broadcasts
    writes to the frontend over the websocket (throttled to avoid flooding
    during progress-bar output)."""

    def __init__(self, original, stream="out"):
        super().__init__()
        self._original = original
        self._stream = stream
        self._last_send = 0.0
        self._pending: list[str] = []

    def write(self, s):
        if s:
            try:
                self._original.write(s)
            except Exception:
                pass
            try:
                State.CONSOLE_BUFFER.append(s)
                self._pending.append(s)
                now = time.time()
                if now - self._last_send >= 0.1:
                    self._flush_broadcast()
            except Exception:
                pass
        return len(s) if s is not None else 0

    def _flush_broadcast(self):
        try:
            if not self._pending:
                return
            chunk = "".join(self._pending)
            self._pending = []
            self._last_send = time.time()
            if hasattr(PromptServer.instance, "send_sync"):
                PromptServer.instance.send_sync(
                    "livedev_console", {"line": chunk, "stream": self._stream}
                )
        except Exception:
            pass

    def flush(self):
        self._flush_broadcast()
        try:
            self._original.flush()
        except Exception:
            pass

    def isatty(self):
        return False

    def fileno(self):
        return -1

    def writable(self):
        return True

    def readable(self):
        return False

    def read(self, *args):
        return ""


def install_console_tee():
    global _CONSOLE_INSTALLED
    if _CONSOLE_INSTALLED:
        return
    try:
        if not isinstance(sys.stdout, _ConsoleTee):
            sys.stdout = _ConsoleTee(sys.stdout, "out")
        if not isinstance(sys.stderr, _ConsoleTee):
            sys.stderr = _ConsoleTee(sys.stderr, "err")
        _CONSOLE_INSTALLED = True
        print("[LiveDev] Console streaming installed")
    except Exception as e:
        print(f"[LiveDev] Console tee install failed: {e}")
