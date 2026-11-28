"""State, paths and the guards, shared by every other module.

Two rules hold this file together.

Everything mutable lives here and nowhere else, because the routes and the reloader both need it and
a copy in each would drift. `WATCH_PAUSED` and `ACTIVE_RELOADER` are read through `State.` rather
than imported by name: `from .State import WATCH_PAUSED` takes a copy of the value at import time,
so a later pause would never be seen by the code that checks it.

The environment is read here for the same reason - the values are settings for the whole pack, not
for whoever happens to read them first.
"""

import json
import logging
import os
import sys
import time
from collections import deque

import folder_paths

# Every path here is built from the pack root, not from this file's own folder: the config and the
# self-module guard both live one level up, and `dirname(__file__)` inside Core would silently point
# at Core - a new config.json beside this module, and a guard that stops recognising LiveDev itself.
PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RELOADED_CLASS_TYPES: dict = {}
CUSTOM_NODE_ROOT: list[str] = folder_paths.folder_names_and_paths["custom_nodes"][0]
CONFIG_PATH = os.path.join(PACK_ROOT, "config.json")
# The reload history outlives the process. It used to be memory only, which threw it away at exactly
# the moment it is wanted - after a crash, to see what last happened.
HISTORY_PATH = os.path.join(PACK_ROOT, "reload_history.json")
LIVEDEV_SELF_MODULE: str = os.path.basename(PACK_ROOT)
RELOAD_HISTORY: deque = deque(maxlen=200)
# Watching is on by default. File events during the startup grace window (State.WATCH_READY_AT) are
# ignored instead, so packs that write configs and caches while they load do not trigger reloads,
# without disabling the hot reload the user expects afterwards. The toggle is a per-session switch.
WATCH_PAUSED: bool = False
WATCH_READY_AT: float = 0.0
CONSOLE_BUFFER: deque = deque(maxlen=600)
LAST_BACKUPS: dict[str, str] = {}
ACTIVE_RELOADER: "DebouncedReloader | None" = None
# How many Terminal nodes the browser can see. The log tail is only read while something is on a
# canvas to receive it, instead of the file being polled forever for a node nobody placed.
TERMINAL_WATCHERS: dict = {"count": 0}


def write_reload_history():
    """Keep the last 200 reloads on disk. A history file that cannot be written must not stop the
    reload that was just recorded, so the failure is logged and dropped."""
    try:
        with open(HISTORY_PATH, "w", encoding="utf-8") as handle:
            json.dump(list(RELOAD_HISTORY), handle)
    except Exception as e:
        logging.debug(f"[LiveDev] reload history not written: {e}")


def read_reload_history() -> list:
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as handle:
            entries = json.load(handle)
        return entries if isinstance(entries, list) else []
    except Exception:
        # No file yet, or one written by an older version: an empty history is the right answer.
        return []


def restore_persisted_state():
    """Put back the one thing that outlives a restart: the reload history.

    The watch state is not restored. Watching is on by default, but file events during the startup
    grace window are ignored, so packs that write configs and caches while they load do not trigger
    reloads. The toggle is a switch for the session it is pressed in.

    Called at the end of the module because it needs the helper above it, and a name bound only
    after an import has walked past its use is worse to read than an explicit call.
    """
    RELOAD_HISTORY.extend(read_reload_history())


def record_reload(module_name, status, duration_ms=0.0, details="", warnings=None):
    RELOAD_HISTORY.append(
        {
            "module": module_name,
            "status": status,
            "durationMs": round(duration_ms, 1),
            "time": time.time(),
            "details": details or "",
            "warnings": list(warnings or [])[:10],
        }
    )
    write_reload_history()


def list_custom_node_modules() -> list[str]:
    mods: list[str] = []
    try:
        for item in os.listdir(CUSTOM_NODE_ROOT[0]):
            item_path = os.path.join(CUSTOM_NODE_ROOT[0], item)
            if item.startswith((".", "_")):
                continue
            if os.path.isdir(item_path) and os.path.exists(
                os.path.join(item_path, "__init__.py")
            ):
                mods.append(item)
            elif os.path.isfile(item_path) and item.endswith(".py"):
                mods.append(item[:-3])
    except Exception:
        pass
    return mods


def is_safe_module_name(name: str) -> bool:
    """A module name is one path segment sitting directly under custom_nodes.

    Every route that turns a name into a path goes through this. The name arrives from the browser,
    and `os.path.join` accepts both an absolute path and `..`, so without the check a reload, a
    backup or a rollback could be aimed at any directory on the disk - `{"module": "C:\\\\Windows"}`
    joins to itself and `shutil.rmtree` then deletes it. A bare file name is what a custom node is,
    so anything else is refused rather than resolved.
    """
    if not name or name in (".", ".."):
        return False
    if name != name.strip():
        return False
    return os.path.basename(name) == name


def load_config() -> dict:

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(config: dict):

    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=4)
    except Exception as e:
        print(f"\033[91m[LiveDev] Error saving config: {str(e)}\033[0m")


def load_exclude_modules() -> set[str]:

    try:
        return set(load_config().get("exclude_modules", set()))
    except Exception as e:
        print(f"\033[91m[LiveDev] Error loading config: {str(e)}\033[0m")
        return set()


def save_exclude_modules(modules: set[str]):

    # Read and write the whole file rather than replacing it: config.json holds more than one
    # setting, and writing a single key drops every other one.
    config = load_config()
    config["exclude_modules"] = list(modules)
    save_config(config)
    print(f"\033[92m[LiveDev] Exclude modules config saved\033[0m")


EXCLUDE_MODULES: set[str] = load_exclude_modules()

# folder_paths lives in the ComfyUI folder, so this is the checkout without hardcoding it.
COMFY_ROOT = os.path.dirname(os.path.abspath(folder_paths.__file__))
UPDATE_DIR = os.path.join(os.path.dirname(COMFY_ROOT), "update")


def resolve_served_file(base_dir: str, file_path: str) -> str | None:
    """Resolve `file_path` under `base_dir` and refuse anything that leaves it.

    The path comes from the URL, and a `..` segment in it would otherwise walk out of the served
    folder and hand back any file on the disk. Only a real file that sits inside the base is
    returned; everything else resolves to None and the caller answers 404.
    """
    base = os.path.abspath(base_dir)
    candidate = os.path.abspath(os.path.join(base, file_path))
    if candidate != base and not candidate.startswith(base + os.sep):
        return None
    return candidate if os.path.isfile(candidate) else None


def is_filesystem_root(path: str) -> bool:
    """True for the top of a drive (`C:\\`) or of the filesystem (`/`), and for nothing else.

    `/livedev/drives` offers roots and the stats bar sends one of them back, so a value below a root
    is not something this pack ever produces. Accepting one anyway would let the route report the
    free space of any directory on the machine.
    """
    drive, tail = os.path.splitdrive(os.path.abspath(path))
    return tail == os.sep or (os.altsep is not None and tail == os.altsep)


# Store dynamic route mappings, so a reloaded pack's routes can be answered while the server runs.
DYNAMIC_API_ROUTES = {}

if (LIVEDEV_EXCLUDE := os.getenv("LIVEDEV_EXCLUDE", None)) is not None:
    EXCLUDE_MODULES.update(x for x in LIVEDEV_EXCLUDE.split(",") if x)

# What used to be environment-only is now saved in config.json beside the exclusions. A value saved
# from the settings panel wins; the environment variable is the fallback for a launch script written
# before the panel existed; the default is the last word when neither is set.
_settings = load_config()


def _saved_or(name, fallback):
    value = _settings.get(name)
    return fallback if value is None else value


def _env_list(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    return [x.strip() for x in raw.split(",") if x.strip()]


def _as_list(value) -> list[str]:
    if isinstance(value, str):
        return [x.strip() for x in value.split(",") if x.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(x).strip() for x in value if str(x).strip()]
    return []


def _clamp_int(value, low, high, fallback):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return fallback


def _clamp_float(value, low, high, fallback):
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return fallback


LIVEDEV_OBSERVE_ONLY: set[str] = set(
    _saved_or("observe_only", _env_list("LIVEDEV_OBSERVE_ONLY", [])))
LIVEDEV_EXTENSIONS: set[str] = set(
    _saved_or("extensions", _env_list("LIVEDEV_EXTENSIONS", [".py"])))
DEBOUNCE_TIME: float = _clamp_float(
    _saved_or("debounce", os.getenv("LIVEDEV_DEBOUNCE_TIME", 1.0)), 0.1, 30.0, 1.0)
START_WATCHING: bool = bool(_saved_or("start_watching", True))
WATCH_PAUSED = not START_WATCHING
DEFER_WHILE_GENERATING: bool = bool(_saved_or("defer_while_generating", True))
RELOAD_DEPENDENTS: bool = bool(_saved_or("reload_dependents", False))
IGNORE_PATTERNS: list[str] = _as_list(_saved_or("ignore_patterns", []))
CONFLICT_TTL: int = _clamp_int(_saved_or("conflict_ttl", 60), 0, 3600, 60)

# The buffers were created before the config was read, so they are sized here. A deque's maxlen is
# fixed at construction and rebuilt rather than changed; `deque(old, maxlen=n)` keeps the contents.
RELOAD_HISTORY = deque(RELOAD_HISTORY, maxlen=_clamp_int(_saved_or("history_size", 200), 10, 5000, 200))
CONSOLE_BUFFER = deque(CONSOLE_BUFFER, maxlen=_clamp_int(_saved_or("console_size", 600), 50, 20000, 600))


def describe_settings() -> dict:
    """The settings in use, for the panel.

    Read from the live values rather than the file: a value can be changed while the server runs, and
    the panel has to show what is actually in use, not what the last save wrote.
    """
    return {
        "start_watching": not WATCH_PAUSED,
        "defer_while_generating": DEFER_WHILE_GENERATING,
        "debounce": DEBOUNCE_TIME,
        "extensions": sorted(LIVEDEV_EXTENSIONS),
        "observe_only": sorted(LIVEDEV_OBSERVE_ONLY),
        "reload_dependents": RELOAD_DEPENDENTS,
        "ignore_patterns": list(IGNORE_PATTERNS),
        "history_size": RELOAD_HISTORY.maxlen,
        "console_size": CONSOLE_BUFFER.maxlen,
        "conflict_ttl": CONFLICT_TTL,
    }


def apply_settings(values: dict) -> None:
    """Change every setting that can change while the server runs, and save it.

    The containers are mutated in place rather than rebound: the reloader holds the same set, so a new
    one here would leave it filtering against the old list. The two deques are the exception, because
    a deque's maxlen cannot change - they are rebuilt, and every reader looks them up through `State.`
    each time rather than holding a copy.
    """
    global WATCH_PAUSED, START_WATCHING, DEFER_WHILE_GENERATING, DEBOUNCE_TIME, RELOAD_DEPENDENTS
    global RELOAD_HISTORY, CONSOLE_BUFFER, CONFLICT_TTL

    saved = load_config()
    if "start_watching" in values:
        START_WATCHING = bool(values["start_watching"])
        WATCH_PAUSED = not START_WATCHING
        saved["start_watching"] = START_WATCHING
    if "defer_while_generating" in values:
        DEFER_WHILE_GENERATING = bool(values["defer_while_generating"])
        saved["defer_while_generating"] = DEFER_WHILE_GENERATING
    if "debounce" in values:
        DEBOUNCE_TIME = _clamp_float(values["debounce"], 0.1, 30.0, DEBOUNCE_TIME)
        saved["debounce"] = DEBOUNCE_TIME
    if "extensions" in values:
        LIVEDEV_EXTENSIONS.clear()
        LIVEDEV_EXTENSIONS.update(_as_list(values["extensions"]) or [".py"])
        saved["extensions"] = sorted(LIVEDEV_EXTENSIONS)
    if "observe_only" in values:
        LIVEDEV_OBSERVE_ONLY.clear()
        LIVEDEV_OBSERVE_ONLY.update(_as_list(values["observe_only"]))
        saved["observe_only"] = sorted(LIVEDEV_OBSERVE_ONLY)
    if "reload_dependents" in values:
        RELOAD_DEPENDENTS = bool(values["reload_dependents"])
        saved["reload_dependents"] = RELOAD_DEPENDENTS
    if "ignore_patterns" in values:
        IGNORE_PATTERNS[:] = _as_list(values["ignore_patterns"])
        saved["ignore_patterns"] = list(IGNORE_PATTERNS)
    if "history_size" in values:
        size = _clamp_int(values["history_size"], 10, 5000, RELOAD_HISTORY.maxlen)
        if size != RELOAD_HISTORY.maxlen:
            RELOAD_HISTORY = deque(RELOAD_HISTORY, maxlen=size)
        saved["history_size"] = size
    if "console_size" in values:
        size = _clamp_int(values["console_size"], 50, 20000, CONSOLE_BUFFER.maxlen)
        if size != CONSOLE_BUFFER.maxlen:
            CONSOLE_BUFFER = deque(CONSOLE_BUFFER, maxlen=size)
        saved["console_size"] = size
    if "conflict_ttl" in values:
        CONFLICT_TTL = _clamp_int(values["conflict_ttl"], 0, 3600, CONFLICT_TTL)
        saved["conflict_ttl"] = CONFLICT_TTL
    save_config(saved)


# Smart Console Noise Filter configuration (persisted under config.json["console_filter"]).
_VALID_FILTER_MODES = {"allow", "mute_info", "mute_all"}
_VALID_FILTER_SCOPES = {"both", "browser", "terminal"}

_saved_filter = load_config().get("console_filter")
if not isinstance(_saved_filter, dict):
    _saved_filter = {}

CONSOLE_FILTER_SOURCES: dict[str, str] = {
    str(k).strip(): str(v)
    for k, v in (_saved_filter.get("sources") or {}).items()
    if str(k).strip() and str(v) in ("mute_info", "mute_all")
}
CONSOLE_FILTER_KEYWORDS: list[str] = [
    str(k).strip()
    for k in (_saved_filter.get("keywords") or [])
    if str(k).strip()
]
CONSOLE_FILTER_SCOPE: str = (
    str(_saved_filter.get("scope"))
    if str(_saved_filter.get("scope")) in _VALID_FILTER_SCOPES
    else "both"
)
CONSOLE_FILTER_KEEP_ERRORS: bool = bool(_saved_filter.get("keep_errors", True))


def get_console_filter_config() -> dict:
    return {
        "sources": dict(CONSOLE_FILTER_SOURCES),
        "keywords": list(CONSOLE_FILTER_KEYWORDS),
        "scope": CONSOLE_FILTER_SCOPE,
        "keep_errors": CONSOLE_FILTER_KEEP_ERRORS,
    }


def save_console_filter_config(patch: dict) -> dict:
    global CONSOLE_FILTER_SCOPE, CONSOLE_FILTER_KEEP_ERRORS
    if isinstance(patch, dict):
        if "sources" in patch and isinstance(patch["sources"], dict):
            for name, mode in patch["sources"].items():
                key = str(name).strip()
                if not key:
                    continue
                m = str(mode).strip()
                if m == "allow" or m not in _VALID_FILTER_MODES:
                    CONSOLE_FILTER_SOURCES.pop(key, None)
                else:
                    CONSOLE_FILTER_SOURCES[key] = m
        if "replace_sources" in patch and isinstance(patch["replace_sources"], dict):
            CONSOLE_FILTER_SOURCES.clear()
            for name, mode in patch["replace_sources"].items():
                key = str(name).strip()
                m = str(mode).strip()
                if key and m in ("mute_info", "mute_all"):
                    CONSOLE_FILTER_SOURCES[key] = m
        if "keywords" in patch and isinstance(patch["keywords"], list):
            seen: set[str] = set()
            cleaned: list[str] = []
            for raw in patch["keywords"]:
                kw = str(raw).strip()
                low = kw.lower()
                if kw and low not in seen:
                    seen.add(low)
                    cleaned.append(kw)
            CONSOLE_FILTER_KEYWORDS[:] = cleaned[:100]
        if "scope" in patch:
            sc = str(patch["scope"]).strip()
            if sc in _VALID_FILTER_SCOPES:
                CONSOLE_FILTER_SCOPE = sc
        if "keep_errors" in patch:
            CONSOLE_FILTER_KEEP_ERRORS = bool(patch["keep_errors"])

    cfg = get_console_filter_config()
    saved = load_config()
    saved["console_filter"] = cfg
    save_config(saved)
    return cfg


# The REPL runs whatever code the request carries inside the server process, so it stays off until
# the machine's owner turns it on. The port is reachable by any page the browser opens, and a POST
# needs no credentials, so a default-on REPL is remote code execution for anyone who can reach it.
LIVEDEV_ENABLE_REPL: bool = os.getenv("LIVEDEV_ENABLE_REPL", "").strip().lower() in ("1", "true", "yes")

try:
    STARTUP_SETTLE_SECONDS: float = float(os.getenv("LIVEDEV_STARTUP_SETTLE", 10.0))
except ValueError:
    STARTUP_SETTLE_SECONDS = 10.0


def is_hidden_file_windows(file_path: str) -> bool:

    try:
        import ctypes

        attribute = ctypes.windll.kernel32.GetFileAttributesW(file_path)
        if attribute == -1:
            return False
        return attribute & 0x2 != 0
    except Exception as e:
        logging.error(f"Error checking if file is hidden on Windows: {e}")
        return False


def is_hidden_file(file_path: str) -> bool:

    file_path = os.path.abspath(file_path)
    if sys.platform.startswith("win"):
        while file_path and file_path != os.path.dirname(file_path):
            if is_hidden_file_windows(file_path):
                return True
            file_path = os.path.dirname(file_path)
    else:
        while file_path and file_path != os.path.dirname(file_path):
            if os.path.basename(file_path).startswith("."):
                return True
            file_path = os.path.dirname(file_path)
    return False


def dfs(item_list: list, searches: set) -> bool:

    for item in item_list:
        if isinstance(item, (frozenset, tuple)) and dfs(item, searches):
            return True
        elif item in searches:
            return True
    return False


restore_persisted_state()
