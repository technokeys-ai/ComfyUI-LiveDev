"""The reload engine: watch a pack, check it, reload it, keep a copy to go back to.

This is the part of the pack that makes it dangerous to get wrong, which is why every path it
builds goes through `State.is_safe_module_name` and every module it loads is compile-checked first.
"""

import asyncio
import fnmatch
import hashlib
import importlib.util
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import warnings
from collections import defaultdict

import nodes
from aiohttp import web
from comfy_execution import caching
from nodes import load_custom_node
from server import PromptServer
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from . import State
from . import DependencyManager

_LAST_DEPS_ALERT: dict[str, float] = {}

# Runtime/cache folders inside custom_nodes that must never trigger live-reload noise.
_IGNORED_WATCH_DIRS = {
    "__pycache__",
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "build",
    "dist",
    "temp",
    "tmp",
    "cache",
    ".cache",
    "logs",
    "output",
    "models",
    "checkpoints",
    "loras",
    ".pytest_cache",
    ".mypy_cache",
}


def _file_sha256(path: str) -> str | None:
    """Return SHA-256 hex digest of a file's contents, or None if unreadable."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _is_comfy_generating() -> bool:
    """True while ComfyUI's prompt queue has an actively executing job."""
    try:
        queue = getattr(PromptServer.instance, "prompt_queue", None)
        if queue is None:
            return False
        running, _pending = queue.get_current_queue()
        return bool(running)
    except Exception:
        return False


def trigger_dependency_check(node_name: str, force: bool = False):
    """Check dependencies for a node in a background thread and alert UI via WebSocket if missing/conflicting."""
    now = time.time()
    last = _LAST_DEPS_ALERT.get(node_name, 0.0)
    if not force and (now - last < 15.0):
        return
    _LAST_DEPS_ALERT[node_name] = now

    def _run():
        try:
            report = DependencyManager.scan_node_dependencies(node_name)
            if report.get("ok") and (report.get("missing_count", 0) > 0 or report.get("conflict_count", 0) > 0):
                if hasattr(PromptServer.instance, "send_sync"):
                    PromptServer.instance.send_sync("livedev_missing_deps", report)
        except Exception as e:
            print(f"\033[91m[LiveDev Deps] Async check failed for {node_name}: {e}\033[0m")

    t = threading.Thread(target=_run, daemon=True)
    t.start()


def syntax_check_module(module_path) -> tuple[bool, list[str]]:
    """Compile-check every .py file of a module before reloading it."""
    errors: list[str] = []
    py_files: list[str] = []
    if os.path.isdir(module_path):
        for root, _, files in os.walk(module_path):
            for f in files:
                if f.endswith(".py"):
                    py_files.append(os.path.join(root, f))
    elif os.path.isfile(module_path) and module_path.endswith(".py"):
        py_files.append(module_path)
    if not py_files:
        return True, []
    for pyf in py_files:
        try:
            with open(pyf, "r", encoding="utf-8", errors="ignore") as fh:
                src = fh.read()
            with warnings.catch_warnings():
                # The check exists to catch a real SyntaxError before the module is loaded. A
                # SyntaxWarning - an invalid escape sequence in another pack's own source, say - is
                # that pack's business: it imports fine, and letting the warning through printed a
                # page of noise on every reload of a pack that never had a syntax error.
                warnings.simplefilter("ignore")
                compile(src, pyf, "exec")
        except Exception as e:
            errors.append(f"{describe_path(pyf)}: {e}")
    return (len(errors) == 0), errors


def describe_path(path: str) -> str:
    """The path relative to the custom-node root that holds it, or the path itself.

    `relpath` raises `ValueError` when the two are on different drives, and that raise used to happen
    inside the message for a syntax error: a pack installed on a second root (a second drive, or an
    extra path) turned a clear "line 12: unexpected EOF" into "path is on mount 'C:', start on mount
    'F:'". A message about a failure must not be able to fail, so the roots are tried in turn and the
    absolute path is the fallback.
    """
    for root in State.CUSTOM_NODE_ROOT:
        try:
            return os.path.relpath(path, root)
        except ValueError:
            continue
    return path


def backup_module(module_name) -> str:
    """Copy the current (working) module to a temp backup for manual rollback."""
    module_path = os.path.join(State.CUSTOM_NODE_ROOT[0], module_name)
    backup_dir = os.path.join(
        tempfile.gettempdir(),
        "livedev_backups",
        module_name + "_" + str(int(time.time() * 1000)),
    )
    _ignore = shutil.ignore_patterns(
        ".git", "__pycache__", "node_modules", ".venv", "venv",
        "models", "checkpoints", "loras", "output", "input", "temp",
    )
    if os.path.isdir(module_path):
        shutil.copytree(module_path, backup_dir, ignore=_ignore)
    else:
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy2(module_path, os.path.join(backup_dir, os.path.basename(module_path)))
    return backup_dir


def restore_after_failed_reload(module_path: str, saved_modules: dict, saved_routes: list) -> None:
    """Put back what a reload that could not finish had already taken apart.

    A reload removes the pack's routes and deletes its modules from `sys.modules` before it knows
    whether the new import will work. Some packs cannot be imported a second time while the server
    runs - one that appends to the frozen aiohttp app at import time, for instance - and without this
    the pack would be left with no module and no routes even though its nodes still work. Whatever the
    failed import added for the pack is dropped first, then the module objects and route table are
    restored to the snapshot taken before the change.
    """
    try:
        for name, module in list(sys.modules.items()):
            if name in saved_modules:
                continue
            if getattr(module, "__file__", None) and module.__file__.startswith(module_path):
                del sys.modules[name]
    except Exception:
        pass
    sys.modules.update(saved_modules)
    try:
        PromptServer.instance.routes._items.clear()
        PromptServer.instance.routes._items.extend(saved_routes)
    except Exception:
        pass


_DEP_GRAPH_CACHE: dict = {"at": 0.0, "data": None}


def classify_nodes(old_nodes: set, new_nodes: set) -> dict:
    """What a reload did to a module's node types, from the two sets of mapping keys.

    Pulled out of the reload path so it can be called on its own. It is the whole contract the
    frontend depends on - which types were added, which are gone, which may need rebuilding - and it
    used to be three set operations buried in a 60-line method that nothing could test without
    reloading a real pack.

    Sorted, because two runs of the same change must produce the same message and a set does not
    promise an order.
    """
    return {
        "added": sorted(new_nodes - old_nodes),
        "removed": sorted(old_nodes - new_nodes),
        "updated": sorted(new_nodes & old_nodes),
    }


def build_dep_graph() -> dict[str, set[str]]:
    """Map custom-node module name -> set of other custom-node modules it imports.

    Reading every `.py` of every installed pack is the expensive part, and it was done again on every
    manual reload. The answer only changes when a file does, and a stale graph costs at most a
    dependent module that is not reloaded with its dependency - so a minute of caching is the right
    trade, the same one the module-conflict report already makes.
    """
    cached = _DEP_GRAPH_CACHE
    now = time.time()
    if cached["data"] is not None and now - cached["at"] < 60:
        return cached["data"]

    mods = set(State.list_custom_node_modules())
    graph: dict[str, set[str]] = {m: set() for m in mods}
    for mod in mods:
        mod_path = os.path.join(State.CUSTOM_NODE_ROOT[0], mod)
        files: list[str] = []
        if os.path.isdir(mod_path):
            for root, _, fs in os.walk(mod_path):
                for f in fs:
                    if f.endswith(".py"):
                        files.append(os.path.join(root, f))
        elif os.path.isfile(mod_path):
            files.append(mod_path)
        for pyf in files:
            try:
                with open(pyf, "r", encoding="utf-8", errors="ignore") as fh:
                    src = fh.read()
                for m in re.finditer(
                    r"^\s*(?:import|from)\s+([a-zA-Z_][\w]*)", src, re.M
                ):
                    target = m.group(1)
                    if target in mods and target != mod:
                        graph[mod].add(target)
            except Exception:
                pass
    cached["at"] = now
    cached["data"] = graph
    return graph


def dependent_modules(module_name) -> set[str]:
    """Modules that import `module_name` (transitively)."""
    graph = build_dep_graph()
    result: set[str] = set()
    frontier = {module_name}
    while frontier:
        nxt: set[str] = set()
        for mod, deps in graph.items():
            if mod not in result and mod != module_name and (deps & frontier):
                result.add(mod)
                nxt.add(mod)
        frontier = nxt
    return result
NODE_TYPE_WHITELIST = {
    "INT", "FLOAT", "STRING", "BOOLEAN", "IMAGE", "LATENT", "MASK",
    "CONDITIONING", "CLIP", "VAE", "MODEL", "CONTROL_NET", "CLIP_VISION",
    "GLIGEN", "STYLE_MODEL", "UPSCALE_MODEL", "PIXEL_ART_MODEL", "LATENT_MASK",
    "SUBCLIP", "SUBCLIP_ENCODING", "DEPTH_MAP", "WEIGHTS", "MODEL_TYPE",
    "REQUIRED_IGNORE", "HIDDEN",
}


def validate_node_schema(node_class, node_name) -> list[str]:
    """Best-effort schema validation of a freshly registered node class.

    V1 and V3 describe a node differently: a V3 node has `define_schema` and none of the V1
    attributes, so a V1-only check reported every modern node as broken. A V3 schema is checked on
    the fields the frontend needs to draw the node at all.
    """
    warnings: list[str] = []
    define_schema = getattr(node_class, "define_schema", None)
    if callable(define_schema):
        try:
            schema = define_schema()
            for field in ("node_id", "display_name", "category"):
                if not getattr(schema, field, None):
                    warnings.append(f"Schema is missing '{field}'")
            if not getattr(schema, "description", ""):
                warnings.append("Schema has no description (the node's info panel stays empty)")
        except Exception as e:
            warnings.append(f"define_schema() failed: {e}")
        return warnings

    try:
        input_types = (
            node_class.INPUT_TYPES()
            if callable(getattr(node_class, "INPUT_TYPES", None))
            else (getattr(node_class, "INPUT_TYPES", None) or {})
        )
        for section in ("required", "optional"):
            for wname, wdef in (input_types.get(section) or {}).items():
                t = wdef
                if isinstance(t, (list, tuple)) and t:
                    t = t[0]
                if isinstance(t, str) and t not in NODE_TYPE_WHITELIST:
                    warnings.append(f"Unknown input type '{t}' (widget '{wname}')")
    except Exception as e:
        warnings.append(f"INPUT_TYPES() failed: {e}")
    for attr in ("RETURN_TYPES", "FUNCTION"):
        if not hasattr(node_class, attr):
            warnings.append(f"Missing class attribute '{attr}'")
    try:
        rt = getattr(node_class, "RETURN_TYPES", None)
        if isinstance(rt, (list, tuple)):
            for t in rt:
                if isinstance(t, str) and t not in NODE_TYPE_WHITELIST:
                    warnings.append(f"Unknown return type '{t}'")
    except Exception:
        pass
    if not getattr(node_class, "CATEGORY", None):
        warnings.append("Missing CATEGORY")
    return warnings


def is_module_match(
    handler_module: str, module_name: str, sys_module_name: str = None
) -> bool:
    """
    Check whether the handler's module name matches the target module.

    Args:
        handler_module: The value of handler.__module__
        module_name: The module name (e.g., "comfyui-clear-screen")
        sys_module_name: The module name in sys.modules ("." in paths replaced with "_x_")

    Returns:
        True if it matches, False otherwise
    """
    if not handler_module:
        return False

    # Direct match
    if module_name == handler_module:
        return True

    # Match sys_module_name (if provided)
    if sys_module_name and sys_module_name == handler_module:
        return True

    # Match various path formats
    patterns = [
        f"custom_nodes.{module_name}",
        f"custom_nodes\\{module_name}",
        f"custom_nodes/{module_name}",
        f"\\{module_name}",
        f"/{module_name}",
    ]

    for pattern in patterns:
        if handler_module.endswith(pattern) or pattern in handler_module:
            return True

    # If sys_module_name is provided, also check its various formats
    if sys_module_name:
        if sys_module_name in handler_module or handler_module in sys_module_name:
            return True

    return False


def register_module_routes(module_name, sys_module_name=None):
    """Register all routes of a module into the dynamic routing table."""
    # Clean up old routes from State.DYNAMIC_API_ROUTES (matched by module path)
    keys_to_remove = []
    for route_key, handler in State.DYNAMIC_API_ROUTES.items():
        if hasattr(handler, "__module__"):
            handler_module = handler.__module__
            if is_module_match(handler_module, module_name, sys_module_name):
                keys_to_remove.append(route_key)

    for key in keys_to_remove:
        del State.DYNAMIC_API_ROUTES[key]

    # Register new routes into the dynamic routing table
    registered_count = 0
    for route in PromptServer.instance.routes:
        if hasattr(route, "handler") and hasattr(route.handler, "__module__"):
            handler_module = route.handler.__module__
            if is_module_match(handler_module, module_name, sys_module_name):
                route_key = f"{route.method}:{route.path}"
                State.DYNAMIC_API_ROUTES[route_key] = route.handler
                registered_count += 1


class DebouncedReloader(FileSystemEventHandler):

    def __init__(self):

        super().__init__()
        self.__last_modified: defaultdict[str, float] = defaultdict(float)
        self.__reload_timers: dict[str, threading.Timer] = {}
        self.__lock: threading.Lock = threading.Lock()
        # Track last successful reload time for cooldown
        self.__last_successful_reload: defaultdict[float] = defaultdict(float)
        self.__successful_reload_cooldown = 5.0  # Cooldown seconds after successful reload
        # Content hash snapshot per watched file so OS reads/AV scans never trigger false reloads
        self.__file_hashes: dict[str, str] = {}
        self.__hashes_ready: bool = False
        self.__last_self_notice: float = 0.0

    def seed_file_hashes(self):
        """Record initial SHA-256 digests of watched custom_nodes files in a background daemon."""
        def _seed():
            root_base = State.CUSTOM_NODE_ROOT[0]
            if not os.path.isdir(root_base):
                self.__hashes_ready = True
                return
            exts = tuple(State.LIVEDEV_EXTENSIONS)
            watch_all = any(e == "*" for e in exts)
            for dirpath, dirnames, filenames in os.walk(root_base):
                dirnames[:] = [
                    d for d in dirnames
                    if d not in _IGNORED_WATCH_DIRS and not d.startswith(".")
                ]
                for fname in filenames:
                    if not watch_all and not any(fname.endswith(ext) for ext in exts):
                        continue
                    full = os.path.normcase(os.path.abspath(os.path.join(dirpath, fname)))
                    digest = _file_sha256(full)
                    if digest is not None:
                        self.__file_hashes[full] = digest
            self.__hashes_ready = True

        threading.Thread(target=_seed, daemon=True).start()

    def _has_real_content_change(self, file_path: str, action: str) -> bool:
        """Verify that a filesystem event represents an actual edit, not a metadata/read touch."""
        norm = os.path.normcase(os.path.abspath(file_path))
        if action == "deleted":
            return self.__file_hashes.pop(norm, None) is not None

        digest = _file_sha256(file_path)
        if digest is None:
            return False

        prev = self.__file_hashes.get(norm)
        if prev is not None:
            if prev == digest:
                return False
            self.__file_hashes[norm] = digest
            return True

        # Unseen file so far: store its digest and check if mtime is actually recent.
        self.__file_hashes[norm] = digest
        if action == "added":
            return True
        try:
            age = time.time() - os.path.getmtime(file_path)
            # If the file was not actually written in the last 10s, Windows fired a phantom touch.
            if age > 10.0:
                return False
        except OSError:
            return False
        return True

    def __reload(self, module_name: str, backup: bool = True, quiet: bool = False) -> web.Response:
        with self.__lock:
            _start_ts = time.time()
            if not State.is_safe_module_name(module_name):
                print(f"\033[91m[LiveDev] Refused reload of invalid module name: {module_name!r}\033[0m")
                return web.Response(text="FAILED")
            try:
                if not quiet:
                    print(
                        f"\n\033[94m[LiveDev] Start reloading module: {module_name}\033[0m"
                    )

                # --- Atomic guard: refuse to reload modules with broken syntax ---
                _module_path_entry = os.path.join(State.CUSTOM_NODE_ROOT[0], module_name)
                _syntax_ok, _syntax_errors = syntax_check_module(_module_path_entry)
                if not _syntax_ok:
                    _err_text = "; ".join(_syntax_errors)[:400]
                    State.record_reload(module_name, "failed", details="Syntax error: " + _err_text)
                    print(
                        f"\033[91m[LiveDev] Reload aborted (syntax error): {module_name}\033[0m"
                    )
                    for _se in _syntax_errors:
                        print(f"\033[91m[LiveDev]   {_se}\033[0m")
                    if hasattr(PromptServer.instance, "send_sync"):
                        PromptServer.instance.send_sync(
                            "livedev_update",
                            {
                                "module": module_name,
                                "action": "failed",
                                "file": _module_path_entry,
                                "timestamp": time.time(),
                                "error": _err_text,
                                "changes": {"added": [], "removed": [], "updated": []},
                            },
                        )
                    return web.Response(text="FAILED")

                # --- Keep a backup of the last working version for manual rollback ---
                if backup:
                    try:
                        State.LAST_BACKUPS[module_name] = backup_module(module_name)
                    except Exception as _be:
                        print(f"\033[91m[LiveDev] Backup failed for {module_name}: {_be}\033[0m")

                # Compute sys_module_name (consistent with load_custom_node logic)
                # load_custom_node replaces "." in paths with "_x_"
                module_path_for_sys = os.path.join(State.CUSTOM_NODE_ROOT[0], module_name)
                sys_module_name = module_path_for_sys.replace(".", "_x_")
                original_routes_count = len(PromptServer.instance.routes)

                # Snapshots taken before either the route table or sys.modules is changed, so a
                # load that fails can put the pack back exactly as it was.
                saved_routes = list(PromptServer.instance.routes._items)

                # Collect routes that need to be retained
                routes_to_keep = []
                routes_removed_count = 0

                for route in PromptServer.instance.routes:
                    should_remove = False
                    if hasattr(route, "handler") and hasattr(
                        route.handler, "__module__"
                    ):
                        handler_module = route.handler.__module__
                        if is_module_match(
                            handler_module, module_name, sys_module_name
                        ):
                            should_remove = True
                            routes_removed_count += 1
                            route_key = f"{route.method}:{route.path}"

                    if not should_remove:
                        routes_to_keep.append(route)

                # Rebuild routing table
                if routes_removed_count > 0:
                    # Since RouteTableDef does not support direct route deletion, use a replacement strategy
                    # Clear and rebuild using _items directly
                    try:
                        PromptServer.instance.routes._items.clear()
                        PromptServer.instance.routes._items.extend(routes_to_keep)
                    except Exception as e:
                        print(
                            f"\033[91m[LiveDev] Route cleanup failed: {str(e)}\033[0m"
                        )
                        traceback.print_exc()
                else:
                    if not quiet:
                        print(
                            f"\033[96m[LiveDev] No routes requiring cleaning were found.\033[0m"
                        )

                module_path = os.path.join(State.CUSTOM_NODE_ROOT[0], module_name)

                # Collect all modules that need to be reloaded
                modules_to_reload = set()
                saved_modules = {}
                for name, module in list(sys.modules.items()):
                    if (
                        hasattr(module, "__file__")
                        and module.__file__
                        and module.__file__.startswith(module_path)
                    ):
                        modules_to_reload.add(name)
                        saved_modules[name] = module

                # Remove all related modules
                for name in modules_to_reload:
                    if name in sys.modules:
                        del sys.modules[name]

                # Reload custom node - track route count before loading
                routes_before_load = len(PromptServer.instance.routes)

                try:
                    # Use asyncio.run to call async function synchronously
                    success = asyncio.run(load_custom_node(module_path))
                except Exception as e:
                    print(
                        f"\033[91m[LiveDev] Calling load_custom_node failed: {str(e)}\033[0m"
                    )
                    success = False

                # Track route count after loading
                routes_after_load = len(PromptServer.instance.routes)

                if not success:
                    restore_after_failed_reload(module_path, saved_modules, saved_routes)
                    trigger_dependency_check(module_name, force=True)
                    if not quiet:
                        print(
                            f"\033[91m[LiveDev] Module loading failed: {module_name}\033[0m"
                        )
                    return web.Response(text="FAILED")

                # Key step: sync new routes to aiohttp's router by directly replacing handlers
                try:
                    # Get newly added routes
                    new_routes_count = routes_after_load - routes_before_load
                    if (
                        new_routes_count > 0
                        and hasattr(PromptServer.instance, "app")
                        and PromptServer.instance.app
                    ):
                        new_routes = list(PromptServer.instance.routes)[
                            -new_routes_count:
                        ]
                        router = PromptServer.instance.app.router

                        for route in new_routes:
                            if (
                                hasattr(route, "method")
                                and hasattr(route, "path")
                                and hasattr(route, "handler")
                            ):
                                if hasattr(route.handler, "__module__"):
                                    handler_module = route.handler.__module__
                                    if is_module_match(
                                        handler_module, module_name, sys_module_name
                                    ):
                                        handler_id = id(route.handler)

                                        # Find and replace old handler
                                        for resource in list(router._resources):
                                            resource_path = getattr(
                                                resource, "_path", None
                                            ) or getattr(resource, "canonical", None)

                                            # Match path (including /api prefixed version)
                                            if resource_path and (
                                                resource_path == route.path
                                                or resource_path == f"/api{route.path}"
                                            ):
                                                for route_obj in resource:
                                                    if hasattr(
                                                        route_obj, "handler"
                                                    ) and hasattr(
                                                        route_obj.handler, "__module__"
                                                    ):
                                                        route_handler_module = (
                                                            route_obj.handler.__module__
                                                        )
                                                        if is_module_match(
                                                            route_handler_module,
                                                            module_name,
                                                            sys_module_name,
                                                        ):
                                                            # Directly replace handler (preserve route cache structure)
                                                            if hasattr(
                                                                route_obj, "_handler"
                                                            ):
                                                                old_id = id(
                                                                    route_obj._handler
                                                                )
                                                                route_obj._handler = (
                                                                    route.handler
                                                                )

                except Exception as e:
                    print(
                        f"\033[91m[LiveDev] Route synchronization failed: {str(e)}\033[0m"
                    )
                    traceback.print_exc()

                # Ensure the module is properly registered in sys.modules
                try:
                    # Build the complete module name (includes custom_nodes prefix)
                    full_module_name = f"custom_nodes.{module_name}"

                    if os.path.isfile(module_path):
                        # Handle single .py file
                        spec = importlib.util.spec_from_file_location(
                            full_module_name, module_path
                        )
                    else:
                        # Handle module directory
                        init_path = os.path.join(module_path, "__init__.py")
                        spec = importlib.util.spec_from_file_location(
                            full_module_name, init_path
                        )

                    if spec:
                        # Track route count before module registration
                        routes_before_register = len(PromptServer.instance.routes)

                        # load_custom_node already executed the module code, just register here in sys.modules
                        # Find the already-loaded module (loaded by load_custom_node)
                        loaded_module = None

                        # Try to find the loaded module in sys.modules.
                        # A snapshot, not the live mapping: reading `__file__` can run a module's
                        # PEP 562 `__getattr__`, which imports a submodule and grows sys.modules
                        # mid-iteration - the RuntimeError this loop used to raise.
                        for mod_name, mod in list(sys.modules.items()):
                            if (
                                hasattr(mod, "__file__")
                                and mod.__file__
                                and mod.__file__.startswith(module_path)
                            ):
                                loaded_module = mod
                                break

                        if loaded_module:
                            # Use loaded module to avoid duplicate execution
                            sys.modules[full_module_name] = loaded_module
                            sys.modules[module_name] = loaded_module

                        else:
                            # If no loaded module found, load normally (fallback)
                            module = importlib.util.module_from_spec(spec)
                            sys.modules[full_module_name] = module
                            sys.modules[module_name] = module
                            spec.loader.exec_module(module)

                except Exception as e:
                    print(
                        f"\033[91m[LiveDev] Module re-registration failed: {str(e)}\033[0m"
                    )
                    traceback.print_exc()

                # Ensure the node is correctly registered to the global NODE_CLASS_MAPPINGS
                module = sys.modules.get(module_name)
                if module and hasattr(module, "NODE_CLASS_MAPPINGS"):
                    # Clean up old node mappings first
                    for name in list(nodes.NODE_CLASS_MAPPINGS.keys()):
                        if name in module.NODE_CLASS_MAPPINGS:
                            del nodes.NODE_CLASS_MAPPINGS[name]

                    # Re-register node
                    for name, node_cls in module.NODE_CLASS_MAPPINGS.items():
                        nodes.NODE_CLASS_MAPPINGS[name] = node_cls
                        node_cls.RELATIVE_PYTHON_MODULE = f"custom_nodes.{module_name}"

                    if hasattr(module, "NODE_DISPLAY_NAME_MAPPINGS"):
                        nodes.NODE_DISPLAY_NAME_MAPPINGS.update(
                            module.NODE_DISPLAY_NAME_MAPPINGS
                        )

                # Update node type
                if module and hasattr(module, "NODE_CLASS_MAPPINGS"):
                    for key in module.NODE_CLASS_MAPPINGS.keys():
                        State.RELOADED_CLASS_TYPES[key] = 3

                # Re-register API routes (to dynamic routing table)
                register_module_routes(module_name, sys_module_name)

                # The module's imports may have changed, so the cached graph is no longer the answer
                # to "who depends on this".
                _DEP_GRAPH_CACHE["data"] = None

                if not quiet:
                    print(
                        f"\033[92m[LiveDev] Module reload successful: {module_name}\033[0m"
                    )
                return web.Response(text="OK")

            except Exception as e:
                logging.error(f"Failed to reload module {module_name}: {e}")
                traceback.print_exc()
                return web.Response(text="FAILED")

    def reload_many(self, module_names: list[str]) -> list[str]:
        """Reload a list of modules, without backing any of them up or narrating each one.

        The rollback copies exist for the one module that was being worked on. Reloading everything is
        for a change that they all import - a shared helper - and copying every pack on the install
        first would make the button unusable rather than careful.

        The per-module lines are suppressed here: on an install with dozens of packs they were hundreds
        of console lines per press. A pack that cannot be reloaded is not special - one that appends to
        the frozen aiohttp app at import time fails only on the second load, which is why its nodes
        still work - so the failures are named once, in the summary, and only successes are returned.
        """
        done = []
        failed = []
        for name in module_names:
            if not State.is_safe_module_name(name):
                continue
            result = self.__reload(name, backup=False, quiet=True)
            if result.text == "OK":
                done.append(name)
            else:
                failed.append(name)
        if failed:
            print(
                f"\033[93m[LiveDev] Reload All: {len(failed)} of {len(done) + len(failed)} "
                f"could not reload - {', '.join(failed)}\033[0m"
            )
        return done

    def force_reload(self, module_name: str) -> str:
        """Manual reload of a module plus every custom-node module that
        depends on it (targeted reload through the dependency graph)."""
        mods = [module_name] + sorted(dependent_modules(module_name))
        for m in mods:
            self.__reload(m)
        return f"OK ({len(mods)} modules: {', '.join(mods)})"

    def on_created(self, event):

        if event.is_directory:
            return
        self.handle_file_event(event.src_path, "added")

    def on_deleted(self, event):

        if event.is_directory:
            return
        self.handle_file_event(event.src_path, "deleted")

    def handle_file_event(self, file_path: str, action: str):

        # File events during the startup grace window are ignored, silently: packs write configs and
        # caches while they load, and reacting to those made every boot reload every pack that did.
        if time.time() < State.WATCH_READY_AT:
            return

        if not any(ext == "*" for ext in State.LIVEDEV_EXTENSIONS):
            if not any(file_path.endswith(ext) for ext in State.LIVEDEV_EXTENSIONS):
                return

        try:
            relative_path: str = os.path.relpath(file_path, State.CUSTOM_NODE_ROOT[0])
        except ValueError:
            return

        parts = relative_path.split(os.path.sep)
        # Skip cache, git, temp, output, venv, and hidden directories immediately (before touching disk)
        if any(part in _IGNORED_WATCH_DIRS or part.startswith(".") for part in parts[:-1]):
            return
        if parts[-1].startswith("."):
            return

        if State.is_hidden_file(file_path):
            return
        if State.IGNORE_PATTERNS:
            # A pattern sees the path under custom_nodes with forward slashes, so `tests/*` reads the
            # same on Windows as elsewhere, and the bare file name, so `*.log` catches it anywhere.
            normalized = relative_path.replace(os.path.sep, "/")
            if any(fnmatch.fnmatch(normalized, pattern) or
                   fnmatch.fnmatch(os.path.basename(file_path), pattern)
                   for pattern in State.IGNORE_PATTERNS):
                return
        root_dir: str = parts[0]
        if root_dir.startswith("_"):
            return  # internal modules (e.g. self-test) are never watched
        if State.LIVEDEV_OBSERVE_ONLY and root_dir not in State.LIVEDEV_OBSERVE_ONLY:
            return
        elif root_dir in State.EXCLUDE_MODULES:
            return

        # Ignore phantom OS modified events (reads, AV scans, metadata updates) where bytes did not change
        if not self._has_real_content_change(file_path, action):
            return

        if root_dir == State.LIVEDEV_SELF_MODULE:
            now = time.time()
            if now - self.__last_self_notice >= 5.0:
                self.__last_self_notice = now
                print(
                    f"\033[93m[LiveDev] Updated '{root_dir}' ({os.path.basename(file_path)}) "
                    f"- restart server to apply LiveDev core changes.\033[0m"
                )
            return

        base_name = os.path.basename(file_path).lower()
        if action == "added" or base_name in ("requirements.txt", "pyproject.toml", "__init__.py"):
            trigger_dependency_check(root_dir)

        self.schedule_reload(root_dir, file_path, action)

    def on_modified(self, event):

        if event.is_directory:
            return
        self.handle_file_event(event.src_path, "modified")

    def schedule_reload(self, module_name: str, file_path: str, action: str, delay: float = None):

        # Silent: watching starts off, and a line per ignored change would trade one kind of startup
        # noise for another. The banner and the Reload History toggle are where the state is read.
        if State.WATCH_PAUSED:
            return

        current_time: float = time.time()
        self.__last_modified[module_name] = current_time
        wait_seconds = State.DEBOUNCE_TIME if delay is None else delay
        with self.__lock:
            if module_name in self.__reload_timers:
                self.__reload_timers[module_name].cancel()
            timer = threading.Timer(
                wait_seconds,
                self.check_and_reload,
                args=[module_name, current_time, file_path, action],
            )
            self.__reload_timers[module_name] = timer
            timer.start()

    def check_and_reload(self, module_name: str, scheduled_time: float, file_path: str,
                         action: str):

        with self.__lock:
            if self.__last_modified[module_name] != scheduled_time:
                return
            # Check if within cooldown period
            current_time = time.time()
            if (
                current_time - self.__last_successful_reload[module_name]
            ) < self.__successful_reload_cooldown:
                return

        # Never interrupt or spam the console while ComfyUI is actively generating images
        if State.DEFER_WHILE_GENERATING and _is_comfy_generating():
            self.schedule_reload(module_name, file_path, action, delay=3.0)
            return

        try:
            _start_ts = time.time()
            # Get node information before reloading
            old_nodes = set()
            old_module = sys.modules.get(module_name)
            if old_module and hasattr(old_module, "NODE_CLASS_MAPPINGS"):
                old_nodes = set(old_module.NODE_CLASS_MAPPINGS.keys())

            # Reload module quietly; failures still log their exact error
            reload_resp = self.__reload(module_name, quiet=True)
            if getattr(reload_resp, "text", None) != "OK":
                print(
                    f"\033[91m[LiveDev] Reload failed for '{module_name}' "
                    f"({os.path.basename(file_path)})\033[0m"
                )
                return

            if State.RELOAD_DEPENDENTS:
                # A shared helper changed and a module that imported it still holds the old object.
                # The changed module goes first, so its dependents are reloaded against the new one.
                for _dep in sorted(dependent_modules(module_name)):
                    self.__reload(_dep, quiet=True)

            # Verify node registration quietly; report only failures if any occur
            module = sys.modules.get(module_name)
            failed_nodes: list[str] = []
            registered_count = 0
            if module and hasattr(module, "NODE_CLASS_MAPPINGS"):
                for node_class in module.NODE_CLASS_MAPPINGS.keys():
                    if node_class in nodes.NODE_CLASS_MAPPINGS:
                        registered_count += 1
                    else:
                        failed_nodes.append(node_class)
            if failed_nodes:
                print(
                    f"\033[91m[LiveDev] Failed registering node(s) in '{module_name}': "
                    f"{', '.join(failed_nodes)}\033[0m"
                )

            # Get node information after reloading
            new_nodes = set()
            if module and hasattr(module, "NODE_CLASS_MAPPINGS"):
                new_nodes = set(module.NODE_CLASS_MAPPINGS.keys())

            # Calculate node changes
            changes = classify_nodes(old_nodes, new_nodes)
            added_nodes, removed_nodes, updated_nodes = (
                changes["added"], changes["removed"], changes["updated"])

            # The timer fires after the debounce, so the file may have gone in the meantime; the
            # event that scheduled this run is what says what happened to it otherwise.
            action = "deleted" if not os.path.exists(file_path) else action

            # Send update message to frontend
            update_message = {
                "type": "livedev_update",
                "data": {
                    "module": module_name,
                    "action": action,
                    "file": file_path,
                    "timestamp": time.time(),
                    "changes": {
                        "added": list(added_nodes),
                        "removed": list(removed_nodes),
                        "updated": list(updated_nodes),
                    },
                },
            }

            if hasattr(PromptServer.instance, "send_sync"):
                PromptServer.instance.send_sync(
                    "livedev_update", update_message["data"]
                )

            # --- Schema validation of freshly registered nodes ---
            _warnings: list[str] = []
            try:
                for _nname in new_nodes:
                    _cls = nodes.NODE_CLASS_MAPPINGS.get(_nname)
                    if _cls:
                        _warnings.extend(validate_node_schema(_cls, _nname))
            except Exception as _ve:
                _warnings.append(f"Schema validation error: {_ve}")

            elapsed_ms = (time.time() - _start_ts) * 1000.0
            State.record_reload(
                module_name,
                "success",
                elapsed_ms,
                details=(
                    f"added={list(added_nodes)} updated={list(updated_nodes)} "
                    f"removed={list(removed_nodes)}"
                ),
                warnings=_warnings[:10],
            )

            self.__last_successful_reload[module_name] = time.time()
            delta_parts = []
            if added_nodes:
                delta_parts.append(f"+{len(added_nodes)} added")
            if removed_nodes:
                delta_parts.append(f"-{len(removed_nodes)} removed")
            delta_str = f" ({', '.join(delta_parts)})" if delta_parts else ""
            changed_file = os.path.basename(file_path)
            print(
                f"\033[92m[LiveDev] Reloaded '{module_name}' ({changed_file}) - "
                f"{registered_count} nodes ready{delta_str} in {elapsed_ms:.0f}ms\033[0m"
            )

        except Exception as e:
            print(f"\033[91m[LiveDev] Reload error in '{module_name}': {e}\033[0m")
            traceback.print_exc()
            try:
                State.record_reload(
                    module_name,
                    "failed",
                    (time.time() - _start_ts) * 1000,
                    details=str(e)[:400],
                )
            except Exception:
                State.record_reload(module_name, "failed", details=str(e)[:400])


def make_observer():
    """The platform's own file-system events, with polling as the fallback.

    Polling re-reads the tree on a timer: on an install with dozens of packs and thousands of files
    that is work done forever for nothing, and the native observer is told by the operating system
    instead. It has no backend on some network shares and some platforms, so the polling one stays as
    the fallback - correct everywhere, just slower.
    """
    try:
        return Observer()
    except Exception as e:
        print(f"[LiveDev] No native file watching on this system ({e}); using polling instead")
        return PollingObserver()


def schedule_watch_grace():
    """Keep the watcher from reacting to the file churn of a server start.

    ComfyUI writes configs and caches while it loads, and an armed watcher took each of those for
    an edit. The grace window starts now and ends a short while after the server's on_startup
    callbacks fire, which is after init_extra_nodes. If the server is not available - a test, or a
    ComfyUI that does not expose on_startup - watching is enabled immediately.
    """
    app = getattr(PromptServer.instance, "app", None)
    if app is None:
        State.WATCH_READY_AT = 0.0
        return
    State.WATCH_READY_AT = time.time() + 300.0
    settle = State.STARTUP_SETTLE_SECONDS

    async def _on_startup(*_args):
        State.WATCH_READY_AT = time.time() + settle

    app.on_startup.append(_on_startup)


class LiveDevService:

    def __init__(self):

        self.__observer = None
        self.__reloader: DebouncedReloader = DebouncedReloader()

    def start(self):

        self.__reloader.seed_file_hashes()
        self.__observer = make_observer()
        self.__observer.schedule(self.__reloader, State.CUSTOM_NODE_ROOT[0], recursive=True)
        self.__observer.start()

    def stop(self):

        if self.__observer:
            self.__observer.stop()
            self.__observer.join()

    def get_reloader(self):

        return self.__reloader


def monkeypatch():
    """Drop the cache entries of the nodes a reload replaced, and nothing else.

    `original_set_prompt` is the **hierarchical** method. It used to be `BasicCache`'s, which meant
    this wrapper substituted the flat behaviour for the hierarchical one on every run - a change to
    how ComfyUI caches, made to fix a reload. Wrapping the method that is actually installed keeps the
    hierarchy and only adds the invalidation.
    """
    original_set_prompt = caching.HierarchicalCache.set_prompt

    def set_prompt(self, dynprompt, node_ids, is_changed_cache):

        if not hasattr(self, "cache_key_set"):
            State.RELOADED_CLASS_TYPES.clear()
            return original_set_prompt(self, dynprompt, node_ids, is_changed_cache)
        found_keys = []
        for key, item_list in self.cache_key_set.keys.items():
            if State.dfs(item_list, State.RELOADED_CLASS_TYPES):
                found_keys.append(key)
        if len(found_keys):
            for value_key in list(State.RELOADED_CLASS_TYPES.keys()):
                State.RELOADED_CLASS_TYPES[value_key] -= 1
                if State.RELOADED_CLASS_TYPES[value_key] == 0:
                    del State.RELOADED_CLASS_TYPES[value_key]
        for key in found_keys:
            cache_key = self.cache_key_set.get_data_key(key)
            if cache_key and cache_key in self.cache:
                del self.cache[cache_key]
                del self.cache_key_set.keys[key]
                del self.cache_key_set.subcache_keys[key]
        return original_set_prompt(self, dynprompt, node_ids, is_changed_cache)

    caching.HierarchicalCache.set_prompt = set_prompt
