import datetime
import os
import threading
import time

import folder_paths
from comfy_api.latest import io
from server import PromptServer


class LiveDev_Terminal(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiveDev_Terminal",
            display_name="🖥 Terminal LiveDev",
            category="🔃 LiveDev/🖥 Console",
            description=(
                "Mirrors the server's log onto the node, so a traceback is readable next to the "
                "graph that produced it. Only the lines written since the last read are sent, and "
                "the node itself does nothing when the graph runs - the panel is driven by the "
                "browser."
            ),
            search_aliases=["terminal", "console", "log", "traceback", "stdout", "server"],
            is_output_node=True,
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        return io.NodeOutput()


CHECKER_THREAD_NAME = "LiveDev.LogFileChecker"
CHECK_INTERVAL = 1.0


def shorten_timestamp(line: str) -> str:
    """Drop the fractional seconds from the prefix ComfyUI writes on every log line."""
    if not line.startswith("[20"):
        return line
    end = line.find("]")
    if end <= 0:
        return line
    return "[" + line[1:end].split(".")[0] + "]" + line[end + 1:]


def LogFileChecker(selfStamp):
    """Follow the server's log file and forward whatever is new.

    One thread per import: reloading this module starts a second thread with a higher stamp, and the
    first one sees it and returns. That is how the old thread is retired without anything holding a
    reference to it.

    The thread is a daemon. It never returns by design, and a non-daemon one keeps the interpreter
    alive at shutdown - ComfyUI could not be closed while this pack was installed.
    """
    checked_line = -1
    checked_mtime = 0.0

    while True:
        try:
            for thread in threading.enumerate():
                if thread.name == CHECKER_THREAD_NAME and thread.__dict__.get("stamp", 0) > selfStamp:
                    return

            port = PromptServer.instance.port if hasattr(PromptServer.instance, "port") else 8000
            log_path = os.path.join(folder_paths.get_user_directory(), f"comfyui_{port}.log")

            if os.path.isfile(log_path):
                mtime = os.path.getmtime(log_path)
                if mtime > checked_mtime + 0.1:
                    checked_mtime = mtime
                    # `errors="replace"` from the first read: one undecodable byte used to fail the
                    # strict read, which then re-read the whole file and sent every line a second
                    # time. And a log that was rotated is shorter than the last one, so the position
                    # is dropped rather than used.
                    with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
                        lines = handle.readlines()
                    if len(lines) <= checked_line:
                        checked_line = -1
                    fresh = lines[checked_line + 1:]
                    first_read = checked_line < 0
                    checked_line = len(lines) - 1
                    # Each line already ends in a newline, so joining them is what keeps the panel
                    # from double-spacing every entry.
                    PromptServer.instance.send_sync(
                        "/livedev.terminal.log",
                        {"text": "".join(shorten_timestamp(line) for line in fresh),
                         "clear": first_read},
                    )
        finally:
            time.sleep(CHECK_INTERVAL)


currentMaxStamp = 0
for thread in threading.enumerate():
    if thread.name == CHECKER_THREAD_NAME:
        currentMaxStamp = max(currentMaxStamp, thread.__dict__.get("stamp", 0))

timestamp = max(int(datetime.datetime.now().timestamp()), currentMaxStamp + 1)
newThread = threading.Thread(target=LogFileChecker, name=CHECKER_THREAD_NAME, args=(timestamp,))
newThread.__dict__["stamp"] = timestamp
newThread.daemon = True
newThread.start()


NODE_CLASS_MAPPINGS = {"LiveDev_Terminal": LiveDev_Terminal}
NODE_DISPLAY_NAME_MAPPINGS = {"LiveDev_Terminal": "🖥 Terminal LiveDev"}
