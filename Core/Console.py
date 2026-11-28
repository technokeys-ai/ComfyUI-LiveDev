"""The console tee and Smart Console Noise Filter.

Captures server stdout/stderr into the in-memory buffer, attributes each line to its originating
custom_node pack, ComfyUI core, or third-party library via a cached fast frame walk (with a bracket
tag fallback), and selectively silences noisy sources according to user rules persisted in
`config.json`.
"""

import io
import os
import re
import sys
import threading
import time
from collections import deque

from server import PromptServer

from . import State

_CONSOLE_INSTALLED: bool = False
_STATS_LOCK = threading.Lock()
_SOURCE_STATS: dict[str, dict] = {}
_PATH_SOURCE_CACHE: dict[str, tuple[str, str]] = {}
_KNOWN_PACKS_LOWER: dict[str, str] = {}
_KNOWN_PACKS_AT: float = 0.0

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_TAG_RE = re.compile(r"^(?:\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[([^\]]{2,48})\]")
_ERROR_RE = re.compile(
    r"(Traceback \(most recent call last\)|"
    r"\b(?:Error|Exception|CRITICAL|FATAL)\s*:|"
    r"\[(?:ERROR|CRITICAL)\]|"
    r"\b(?:SyntaxError|RuntimeError|TypeError|ValueError|ImportError|ModuleNotFoundError|"
    r"KeyError|AttributeError|OSError|PermissionError|FileNotFoundError|CUDA out of memory)\b)"
)

_SKIP_FILENAMES = (
    os.path.normcase(os.path.abspath(__file__)),
)
_SKIP_STDLIB_MARKERS = (
    os.sep + "logging" + os.sep,
    os.sep + "warnings.py",
    os.sep + "threading.py",
    os.sep + "codecs.py",
    os.sep + "io.py",
    os.sep + "tqdm" + os.sep,
)

_CUSTOM_NODES_ROOT_NORM = os.path.normcase(
    os.path.abspath(State.CUSTOM_NODE_ROOT[0])
) if State.CUSTOM_NODE_ROOT else ""
_COMFY_ROOT_NORM = os.path.normcase(os.path.abspath(State.COMFY_ROOT))


def _refresh_known_packs() -> dict[str, str]:
    global _KNOWN_PACKS_AT
    now = time.time()
    if _KNOWN_PACKS_LOWER and now - _KNOWN_PACKS_AT < 30.0:
        return _KNOWN_PACKS_LOWER
    _KNOWN_PACKS_AT = now
    try:
        root = State.CUSTOM_NODE_ROOT[0]
        if os.path.isdir(root):
            mapping = {}
            for item in os.listdir(root):
                if item.startswith(".") or item == "__pycache__":
                    continue
                if os.path.isdir(os.path.join(root, item)):
                    mapping[item.lower()] = item
                    # Also index simplified token without ComfyUI- prefix for tag matching
                    short = re.sub(r"^comfyui[-_]", "", item, flags=re.I).lower()
                    if short and short not in mapping:
                        mapping[short] = item
            _KNOWN_PACKS_LOWER.clear()
            _KNOWN_PACKS_LOWER.update(mapping)
    except Exception:
        pass
    return _KNOWN_PACKS_LOWER


def _classify_file_path(filename: str) -> tuple[str, str]:
    cached = _PATH_SOURCE_CACHE.get(filename)
    if cached is not None:
        return cached

    norm = os.path.normcase(os.path.abspath(filename)) if filename and not filename.startswith("<") else ""
    result: tuple[str, str] = ("", "")

    if not norm or norm in _SKIP_FILENAMES:
        result = ("", "")
    elif any(marker in norm for marker in _SKIP_STDLIB_MARKERS):
        result = ("", "")
    elif _CUSTOM_NODES_ROOT_NORM and norm.startswith(_CUSTOM_NODES_ROOT_NORM + os.sep):
        rel = os.path.abspath(filename)[len(os.path.abspath(State.CUSTOM_NODE_ROOT[0])) + 1:]
        top = rel.split(os.sep, 1)[0]
        if top:
            result = (top, "custom_node")
    elif _COMFY_ROOT_NORM and norm.startswith(_COMFY_ROOT_NORM + os.sep):
        result = ("ComfyUI Core", "core")
    else:
        sp_marker = os.sep + "site-packages" + os.sep
        idx = norm.find(sp_marker)
        if idx != -1:
            after = os.path.abspath(filename)[idx + len(sp_marker):]
            pkg = after.split(os.sep, 1)[0]
            if pkg and not pkg.startswith("_"):
                result = (f"Lib: {pkg}", "library")

    if len(_PATH_SOURCE_CACHE) > 4096:
        _PATH_SOURCE_CACHE.clear()
    _PATH_SOURCE_CACHE[filename] = result
    return result


def _resolve_source(clean_text: str) -> tuple[str, str]:
    """Identify which custom_node pack, core module, or library produced this console write."""
    # Layer 1: Fast cached stack-frame inspection (sys._getframe avoids inspect.stack overhead)
    try:
        frame = sys._getframe(2)
        depth = 0
        fallback_lib: tuple[str, str] | None = None
        fallback_core: tuple[str, str] | None = None
        while frame is not None and depth < 18:
            src, kind = _classify_file_path(frame.f_code.co_filename)
            if kind == "custom_node":
                return src, kind
            if kind == "core" and fallback_core is None:
                fallback_core = (src, kind)
            elif kind == "library" and fallback_lib is None:
                fallback_lib = (src, kind)
            frame = frame.f_back
            depth += 1
        # If text has an explicit bracket tag like [QwenVL] from a helper or core logger, match pack
        tag_src = _match_tag_source(clean_text)
        if tag_src is not None:
            return tag_src
        if fallback_core is not None:
            return fallback_core
        if fallback_lib is not None:
            return fallback_lib
    except Exception:
        pass

    tag_src = _match_tag_source(clean_text)
    if tag_src is not None:
        return tag_src
    return ("System / Other", "system")


def _match_tag_source(clean_text: str) -> tuple[str, str] | None:
    stripped = clean_text.lstrip()
    m = _TAG_RE.match(stripped)
    if not m:
        return None
    raw_tag = m.group(1).strip()
    if not raw_tag:
        return None
    low = raw_tag.lower()
    if low in ("info", "warning", "warn", "error", "debug", "critical"):
        return None
    packs = _refresh_known_packs()
    if low in packs:
        return (packs[low], "custom_node")
    compact = re.sub(r"[^a-z0-9]", "", low)
    if compact:
        for k, pack_name in packs.items():
            if re.sub(r"[^a-z0-9]", "", k) == compact:
                return (pack_name, "custom_node")
    return (f"Tag: [{raw_tag}]", "tag")


def _is_error_line(clean_text: str, stream: str) -> bool:
    if _ERROR_RE.search(clean_text):
        return True
    if stream == "err" and ("Error" in clean_text or "Traceback" in clean_text):
        return True
    return False


def _evaluate_mute(source: str, clean_text: str, stream: str) -> tuple[bool, bool]:
    """Return (mute_terminal, mute_browser) based on user rules in State."""
    mode = State.CONSOLE_FILTER_SOURCES.get(source, "allow")
    matched = False

    if mode == "mute_all":
        matched = True
    elif mode == "mute_info":
        if not _is_error_line(clean_text, stream):
            matched = True
    elif State.CONSOLE_FILTER_KEYWORDS:
        low = clean_text.lower()
        for kw in State.CONSOLE_FILTER_KEYWORDS:
            if kw.lower() in low:
                if not (State.CONSOLE_FILTER_KEEP_ERRORS and _is_error_line(clean_text, stream)):
                    matched = True
                break

    if not matched:
        return (False, False)

    scope = State.CONSOLE_FILTER_SCOPE
    if scope == "browser":
        return (False, True)
    if scope == "terminal":
        return (True, False)
    return (True, True)


def _record_source_activity(source: str, kind: str, clean_text: str, was_muted: bool) -> None:
    snippet = clean_text.strip()
    if not snippet:
        return
    if len(snippet) > 240:
        snippet = snippet[:237] + "..."
    now = time.time()
    with _STATS_LOCK:
        entry = _SOURCE_STATS.get(source)
        if entry is None:
            entry = {
                "name": source,
                "kind": kind,
                "lines": 0,
                "muted": 0,
                "last_seen": now,
                "samples": deque(maxlen=12),
            }
            _SOURCE_STATS[source] = entry
        entry["lines"] += 1
        if was_muted:
            entry["muted"] += 1
        entry["last_seen"] = now
        entry["samples"].append({"text": snippet, "muted": was_muted, "ts": now})


def get_console_filter_snapshot() -> dict:
    """Return current filter rules plus live per-source console activity sorted by volume."""
    cfg = State.get_console_filter_config()
    sources_map = cfg["sources"]
    with _STATS_LOCK:
        rows = []
        seen = set()
        total_lines = 0
        total_muted = 0
        for name, st in _SOURCE_STATS.items():
            seen.add(name)
            total_lines += st["lines"]
            total_muted += st["muted"]
            rows.append({
                "name": name,
                "kind": st["kind"],
                "lines": st["lines"],
                "muted": st["muted"],
                "last_seen": st["last_seen"],
                "mode": sources_map.get(name, "allow"),
                "samples": list(st["samples"]),
            })
        # Also include configured rules for sources that have not printed yet this session
        for name, mode in sources_map.items():
            if name not in seen:
                rows.append({
                    "name": name,
                    "kind": "custom_node" if not name.startswith(("Lib:", "Tag:", "ComfyUI", "System")) else "rule",
                    "lines": 0,
                    "muted": 0,
                    "last_seen": 0.0,
                    "mode": mode,
                    "samples": [],
                })
    rows.sort(key=lambda r: (0 if r["mode"] != "allow" else 1, -r["lines"], r["name"].lower()))
    return {
        "ok": True,
        "config": cfg,
        "sources": rows,
        "total_lines": total_lines,
        "total_muted": total_muted,
    }


def reset_console_stats() -> None:
    with _STATS_LOCK:
        _SOURCE_STATS.clear()


class _ConsoleTee(io.TextIOBase):
    """Tees server stdout/stderr into the in-memory buffer and broadcasts writes to the frontend,
    applying Smart Console Noise Filter rules per originating project."""

    def __init__(self, original, stream="out"):
        super().__init__()
        self._original = original
        self._stream = stream
        self._last_send = 0.0
        self._pending: list[str] = []
        self._local = threading.local()

    def write(self, s):
        if not s:
            return 0
        # Re-entrancy guard: never recurse if logging happens inside classifier
        if getattr(self._local, "busy", False):
            try:
                self._original.write(s)
            except Exception:
                pass
            return len(s)

        self._local.busy = True
        try:
            clean = _ANSI_RE.sub("", s)
            mute_term = False
            mute_browser = False
            if clean.strip():
                source, kind = _resolve_source(clean)
                mute_term, mute_browser = _evaluate_mute(source, clean, self._stream)
                _record_source_activity(source, kind, clean, mute_term or mute_browser)

            if not mute_term:
                try:
                    self._original.write(s)
                except Exception:
                    pass
            if not mute_browser:
                try:
                    State.CONSOLE_BUFFER.append(s)
                    self._pending.append(s)
                    now = time.time()
                    if now - self._last_send >= 0.1:
                        self._flush_broadcast()
                except Exception:
                    pass
        finally:
            self._local.busy = False
        return len(s)

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
        print("[LiveDev] Console streaming & smart noise filter installed")
    except Exception as e:
        print(f"[LiveDev] Console tee install failed: {e}")
