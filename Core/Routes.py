"""Every HTTP route the pack adds.

Nothing here holds state of its own beyond the caches that belong to one report: the settings, the
backups and the reload history all live in `State`, and `ACTIVE_RELOADER` is read through it so a
route can never hold a stale copy.
"""

import asyncio
import gc
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from collections import defaultdict

import folder_paths
import nodes
import psutil
import requests
from aiohttp import web
from nodes import load_custom_node
from server import PromptServer

from . import State
from . import DependencyManager

_MODULE_CONFLICTS_CACHE: dict = {"at": 0.0, "data": None}


@PromptServer.instance.routes.get("/livedev/get_exclude_modules")
async def get_exclude_modules(request):
    return web.json_response({"exclude_modules": list(State.EXCLUDE_MODULES)})


@PromptServer.instance.routes.post("/livedev/update_exclude_modules")
async def update_exclude_modules(request):
    try:
        data = await request.json()
        modules = set(data.get("exclude_modules", []))
        # Mutated in place rather than rebound: the reloader holds the same set, and a new one here
        # would leave it filtering against the old list.
        State.EXCLUDE_MODULES.clear()
        State.EXCLUDE_MODULES.update(modules)
        State.save_exclude_modules(modules)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/get_settings")
async def get_settings(request):
    return web.json_response({"settings": State.describe_settings()})


@PromptServer.instance.routes.post("/livedev/update_settings")
async def update_settings(request):
    """Save the settings that can change while the server runs.

    A value outside its range is clamped rather than refused: the panel offers the range, and a
    hand-written request should not be able to set a debounce of ten minutes or a history of a
    million entries. Only the keys present are changed, so two panels saving at once cannot wipe
    each other's value.
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid request"}, status=400)
    State.apply_settings(data if isinstance(data, dict) else {})
    return web.json_response({"ok": True, "settings": State.describe_settings()})


@PromptServer.instance.routes.get("/livedev/get_all_modules")
async def get_all_modules(request):
    try:
        modules = []
        for item in os.listdir(State.CUSTOM_NODE_ROOT[0]):
            item_path = os.path.join(State.CUSTOM_NODE_ROOT[0], item)
            if os.path.isdir(item_path) and not item.startswith("."):
                if os.path.exists(os.path.join(item_path, "__init__.py")):
                    modules.append(item)
        return web.json_response({"modules": modules})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/module_conflicts")
async def get_module_conflicts(request):
    """Python module names that more than one custom node defines.

    A pack that puts its own folder on sys.path makes its .py files importable by bare name, so two
    packs shipping the same file name means one of them silently wins - whichever was imported
    last, which is decided by load order and not by anything the user chose. The symptom appears in
    a pack that was never at fault: a TypeError, or an attribute that should exist and does not.

    AILab_QwenVL_GGUF was installed by three packs at once and the wrong one won, so the loader
    that ran took fifteen parameters while the caller passed eight. The loaded_from field is what
    turns a list of names into an answer - it says which of the duplicates Python is really using.

    The walk is cached for a minute because it visits every pack, and the report asks for it on
    every build.
    """
    try:
        cached = _MODULE_CONFLICTS_CACHE
        now = time.time()
        if cached["data"] is not None and now - cached["at"] < State.CONFLICT_TTL:
            return web.json_response(cached["data"])

        defined = defaultdict(list)
        for item in os.listdir(State.CUSTOM_NODE_ROOT[0]):
            folder = os.path.join(State.CUSTOM_NODE_ROOT[0], item)
            if not os.path.isdir(folder) or item.startswith("."):
                continue
            for root, dirnames, filenames in os.walk(folder):
                dirnames[:] = [d for d in dirnames
                               if d not in ("__pycache__", ".git", "node_modules", ".disabled")]
                for name in filenames:
                    # Every pack has an __init__.py, so it would always read as a conflict.
                    if not name.endswith(".py") or name == "__init__.py":
                        continue
                    defined[name[:-3]].append(
                        os.path.relpath(os.path.join(root, name), State.CUSTOM_NODE_ROOT[0])
                        .replace("\\", "/"))

        conflicts = {}
        for stem, paths in defined.items():
            if len(paths) < 2:
                continue
            entry = {"defined_in": sorted(paths)}
            loaded = getattr(sys.modules.get(stem), "__file__", None)
            if loaded:
                try:
                    entry["loaded_from"] = (os.path.relpath(loaded, State.CUSTOM_NODE_ROOT[0])
                                            .replace("\\", "/"))
                except ValueError:
                    entry["loaded_from"] = os.path.basename(loaded)
            conflicts[stem] = entry

        payload = {
            "ok": True,
            "scanned": len(defined),
            "count": len(conflicts),
            "conflicts": conflicts,
        }
        cached["at"] = now
        cached["data"] = payload
        return web.json_response(payload)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


def _memory_usage():
    """RAM and VRAM in MB, read the way the stats bar reads them."""
    ram_mb = 0
    try:
        ram_mb = int(psutil.virtual_memory().used / (1024 * 1024))
    except Exception:
        pass
    vram_mb = 0
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=3).strip()
        vram_mb = int(float(out.splitlines()[0]))
    except Exception:
        try:
            import torch
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info()
                vram_mb = round((total_b - free_b) / (1024 ** 2))
        except Exception:
            pass
    return {"ram_mb": ram_mb, "vram_mb": vram_mb}

@PromptServer.instance.routes.post("/livedev/free_memory")
async def free_memory(request):
    """Release VRAM and RAM.

    ComfyUI keeps models loaded between runs, which is the right default until a large checkpoint
    is sitting on the card doing nothing. Python holds the other half: freed tensors stay in the
    allocator's pool, and cycles stay alive until a collection runs, so empty_cache on its own
    returns very little.

    The order is the point. Models are unloaded first, because they own the largest tensors and
    dropping those references is what makes the memory collectable at all - a collection run
    before the unload finds everything still reachable and frees nothing.
    """
    try:
        before = _memory_usage()
        unloaded = 0
        try:
            import comfy.model_management as model_management
            unloaded = len(model_management.current_loaded_models or [])
            model_management.unload_all_models()
            model_management.soft_empty_cache()
        except Exception:
            pass
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass
        return web.json_response({"ok": True, "unloaded": unloaded,
                                  "before": before, "after": _memory_usage()})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
_UPDATE_CACHE: dict = {"at": 0.0, "data": None}

# The portable build's updater, the only one this pack knows how to run. A Linux or macOS checkout
# has no equivalent here, and that is a fact to report rather than a button that fails.
_UPDATER_SCRIPT = "update_comfyui_stable.bat"


def _git(*args, timeout=25):
    return subprocess.run(["git", "-C", State.COMFY_ROOT, *args],
                          capture_output=True, text=True, timeout=timeout)


def _run_streamed(args, cwd, timeout, label):
    """Run a command, echo every line it prints to the console, and return (code, output).

    The updater takes minutes and reports what it is doing; capturing it and returning only the tail
    at the end meant the console showed nothing while it ran, so an update could not be told apart
    from a hang. The lines are printed as they arrive - the console tee carries them to the browser
    as well - and collected for the last part of the response. A timer kills a command that produces
    no output for the whole timeout, which reading the pipe directly cannot.
    """
    proc = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, encoding="utf-8", errors="replace")
    timed_out = {"value": False}

    def _kill():
        timed_out["value"] = True
        try:
            proc.kill()
        except Exception:
            pass

    timer = threading.Timer(timeout, _kill)
    timer.daemon = True
    timer.start()
    lines = []
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            lines.append(line)
            print(f"\033[94m[LiveDev] {label} | {line}\033[0m")
    finally:
        timer.cancel()
        if proc.stdout:
            proc.stdout.close()
        proc.wait()
    if timed_out["value"]:
        raise subprocess.TimeoutExpired(args, timeout)
    return proc.returncode, "\n".join(lines)

def _latest_release():
    """The newest release tag upstream has actually published.

    Not the newest tag. This repository tags far more commits than it releases - v0.37.1 and
    v0.37.2 both exist as tags reachable from master and neither is a release - so a tag
    comparison offers the user an update that upstream has not published, which is a lie the
    user cannot check without reading the repository.
    """
    response = requests.get(
        "https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest",
        headers={"User-Agent": "ComfyUI-LiveDev"}, timeout=15)
    response.raise_for_status()
    return str(response.json().get("tag_name") or "").strip()


def _version_tuple(text: str):
    """The numeric version at the start of a tag or describe string, as a tuple to compare.

    `v0.39.0` and `0.39.0` both give `(0, 39, 0)`; a checkout that is commits past its tag, which
    `git describe` writes as `v0.39.0-3-gabc1234`, keeps `(0, 39, 0)` because it is still at least
    that version. `None` when there is no version to read, so the caller can fall back.
    """
    match = re.match(r"^v?(\d+(?:\.\d+)*)", text or "")
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


@PromptServer.instance.routes.get("/livedev/update_check")
async def update_check(request):
    """Whether a newer ComfyUI release is available.

    The comparison is against the releases upstream has published, because that is the only
    definition of "an update" a user can act on. See _latest_release for why tags are wrong here.

    The published release also has to be **newer** than this checkout, not merely different: a
    checkout that is commits past the newest release is ahead of it, and comparing for inequality
    alone read as `v0.39.2  ->  v0.39.0`, an update that is a downgrade.

    The answer is cached because it is a network round trip and it cannot change faster than a
    release. When the check itself fails the answer says so rather than reporting no update -
    a failed check and a current install are different things, and only one of them is silent.

    `updater` says whether this install has the script that would do the update. It is reported
    separately from `available` because the two are independent: a Linux checkout can be behind
    upstream and still have no `.bat` to run, and offering the button there would only fail later.
    """
    try:
        cached = _UPDATE_CACHE
        now = time.time()
        if cached["data"] is not None and now - cached["at"] < 300:
            return web.json_response(cached["data"])

        has_updater = os.path.isfile(os.path.join(State.UPDATE_DIR, _UPDATER_SCRIPT))

        if not os.path.isdir(os.path.join(State.COMFY_ROOT, ".git")):
            return web.json_response({"ok": True, "available": False, "updater": has_updater,
                                      "reason": "this install is not a git checkout"})

        current = _git("describe", "--tags", "--always").stdout.strip()
        latest = _latest_release()
        ignored = State.load_config().get("ignored_update") or ""

        current_version = _version_tuple(current)
        latest_version = _version_tuple(latest)
        if current_version is not None and latest_version is not None:
            # A tag reachable from HEAD that is newer than the newest published release is not an
            # update: this checkout is ahead of it. Comparing tags for inequality alone offered the
            # user a downgrade, which the panel read as `v0.39.2  ->  v0.39.0`.
            newer = latest_version > current_version
        else:
            newer = current != latest

        payload = {
            "ok": True,
            "available": bool(latest) and latest != ignored and newer,
            "updater": has_updater,
            "current": current,
            "latest": latest,
            "ignored": ignored or None,
        }
        cached["at"] = now
        cached["data"] = payload
        return web.json_response(payload)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post("/livedev/update")
async def run_update(request):
    """Update the checkout, then the Python packages in requirements.txt.

    Not `git pull`. The stable channel is a detached checkout of a release tag, so a pull either
    does nothing or lands the checkout on a branch and silently changes the channel. update.py is
    the script the portable build ships for this, and running it is what the Update ComfyUI bat
    does - including the second pass that is needed when the updater replaces itself, which is
    why the bat is run rather than update.py directly.

    The updater's own requirements step is silent and swallows a failure, so requirements.txt is
    installed again here where the output can be seen. That step reaches pypi.org, and the checkout
    update reaches github.com; both run only because the user pressed Update.

    Every line either step prints goes to the console as it arrives. A restart afterwards is
    unavoidable, and it is the honest answer to "can this be done while ComfyUI runs": the new files
    are on disk, but the running process has already imported the old ones and will keep executing
    them until it exits.
    """
    try:
        script = os.path.join(State.UPDATE_DIR, _UPDATER_SCRIPT)
        if not os.path.isfile(script):
            return web.json_response(
                {"ok": False, "error": "no updater script for this install"}, status=400)

        print(f"\033[94m[LiveDev] Update: running {_UPDATER_SCRIPT}\033[0m")
        # The bat ends in `if "%~1"=="" pause`, so passing an argument is what keeps it from
        # waiting for a keypress that will never come. Off the event loop: this is minutes.
        code, output = await asyncio.to_thread(
            _run_streamed, ["cmd", "/c", script, "nogui"], State.UPDATE_DIR, 1800, "update")
        if code != 0:
            _UPDATE_CACHE["data"] = None
            return web.json_response({"ok": False, "returncode": code,
                                      "error": "the updater failed", "output": output[-4000:]})

        requirements = os.path.join(State.COMFY_ROOT, "requirements.txt")
        pip_output = ""
        if os.path.isfile(requirements):
            print("\033[94m[LiveDev] Update: installing requirements.txt\033[0m")
            pip_code, pip_output = await asyncio.to_thread(
                _run_streamed,
                [sys.executable, "-s", "-m", "pip", "install", "-r", requirements],
                State.COMFY_ROOT, 1800, "pip")
            if pip_code != 0:
                _UPDATE_CACHE["data"] = None
                return web.json_response({"ok": False, "returncode": pip_code,
                                          "error": "requirements install failed",
                                          "output": (output + "\n" + pip_output)[-4000:]})

        _UPDATE_CACHE["data"] = None
        return web.json_response({"ok": True, "returncode": 0,
                                  "output": (output + "\n" + pip_output)[-4000:]})
    except subprocess.TimeoutExpired:
        return web.json_response({"ok": False, "error": "the update timed out"}, status=500)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/update_ignore")
async def update_ignore(request):
    """Stop offering one release.

    The check is a comparison against the newest tag, so on its own it cannot tell "a newer
    release exists" from "the user wants it". Staying on an older release is a legitimate choice,
    and without this the marker would return after every dismissal.

    Only the one version is silenced. The check fires again as soon as something newer appears,
    which is what keeps this from becoming "never update again".
    """
    try:
        body = await request.json()
        version = str(body.get("version") or "").strip()
        config = State.load_config()
        config["ignored_update"] = version
        State.save_config(config)
        _UPDATE_CACHE["data"] = None
        return web.json_response({"ok": True, "ignored": version})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/extensions/{module_name}/{path:.*}")
async def dynamic_extensions_handler(request):
    """Handle WEB_DIRECTORY file access for dynamically loaded plugins."""
    module_name = request.match_info["module_name"]
    file_path = request.match_info["path"]

    # Look up from EXTENSION_WEB_DIRS first (custom nodes, supports hot reload)
    if module_name in nodes.EXTENSION_WEB_DIRS:
        full_path = State.resolve_served_file(nodes.EXTENSION_WEB_DIRS[module_name], file_path)
        if full_path:
            return web.FileResponse(full_path)

    # If not in EXTENSION_WEB_DIRS, try the extensions directory of the ComfyUI frontend package (system extensions like core)
    # PromptServer.instance.web_root points to the static file directory of the frontend package
    # e.g., E:\python3.11\Lib\site-packages\comfyui_frontend_package\static
    if hasattr(PromptServer.instance, "web_root") and PromptServer.instance.web_root:
        full_path = State.resolve_served_file(
            os.path.join(PromptServer.instance.web_root, "extensions", module_name), file_path)
        if full_path:
            return web.FileResponse(full_path)

    # If not found, return 404
    raise web.HTTPNotFound()


@PromptServer.instance.routes.get("/api/{path:.*}")
async def dynamic_api_handler(request):
    """Dynamically handle hot-updated API routes."""
    path = "/" + request.match_info["path"]  # Reconstruct full path
    method = request.method.upper()

    # Look up dynamically registered handler
    route_key = f"{method}:{path}"
    if route_key in State.DYNAMIC_API_ROUTES:
        handler = State.DYNAMIC_API_ROUTES[route_key]
        return await handler(request)

    # If no dynamic route found, let the system continue
    raise web.HTTPNotFound()


@PromptServer.instance.routes.post("/livedev/clear_console")
async def clear_console(request):
    """Clear the server console and the buffer the browser mirrors it from.

    The erase-screen escape is written straight to the stream instead of handing a string to a
    shell: the old version spawned a command process for what is one escape sequence, and it
    needed a different spelling per platform. The buffer is emptied too, because the console panel
    reads that buffer - clearing only the terminal would leave every old line in the panel.
    """
    State.CONSOLE_BUFFER.clear()
    for stream in (sys.stdout, sys.stderr):
        # A tee keeps the real stream beside it; write there so the escape is not re-broadcast.
        target = getattr(stream, "_original", stream)
        try:
            target.write("\033[2J\033[H")
            target.flush()
        except Exception:
            pass
    return web.json_response({"status": "cleared"})


@PromptServer.instance.routes.post("/livedev/shutdown")
async def shutdown_server(request):
    try:
        print("\033[91m[LiveDev] Shutting down server...\033[0m")
        threading.Thread(target=shutdown_with_delay, daemon=True).start()
        return web.json_response({"status": "shutting_down"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


def shutdown_with_delay():
    time.sleep(1)
    os._exit(0)


@PromptServer.instance.routes.post("/livedev/restart")
async def restart_server(request):
    try:
        print("\033[93m[LiveDev] Restarting server...\033[0m")
        threading.Thread(target=restart_with_delay, daemon=True).start()
        return web.json_response({"status": "restarting"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


def restart_with_delay():
    time.sleep(1)
    python = sys.executable
    os.execl(python, python, *sys.argv)
_GPU_DATA = {"name": "", "driver": ""}

# nvidia-smi is a process launch, and the stats bar asks every couple of seconds while the numbers
# it returns move on the scale of a second. Two seconds of cache removes most of the launches
# without the reading ever looking stale.
_GPU_STATS: dict = {"at": 0.0, "value": None}

# One Process object for the life of the server. cpu_percent with no interval reports the change
# since the previous call on that object, so a fresh one built per request has nothing to compare
# against and answers 0 every time.
_STATS_PROCESS = psutil.Process()

def _detect_gpu():
    global _GPU_DATA
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"], text=True, timeout=5).strip()
        if out:
            parts = out.split(", ")
            _GPU_DATA["name"] = parts[0]
            _GPU_DATA["driver"] = parts[1] if len(parts) > 1 else ""
    except Exception:
        try:
            out = subprocess.check_output(["rocm-smi", "--showproductname"], text=True, timeout=5).strip()
            _GPU_DATA["name"] = out.split("\n")[0] if out else "AMD GPU"
        except Exception:
            _GPU_DATA["name"] = "GPU (not detected)"

_detect_gpu()


@PromptServer.instance.routes.get("/livedev/stats")
async def get_stats(request):
    try:
        cpu = psutil.cpu_percent(interval=0)
        ram = psutil.virtual_memory()
        proc = _STATS_PROCESS
        proc_cpu = proc.cpu_percent(interval=0) / psutil.cpu_count()
        proc_mem = proc.memory_info().rss / (1024**3)

        now = time.time()
        if _GPU_STATS["value"] is not None and now - _GPU_STATS["at"] < 2:
            gpu_temp, gpu_percent, gpu_mem_percent, vram_used, vram_total = _GPU_STATS["value"]
        else:
            gpu_percent = 0
            gpu_temp = 0
            gpu_mem_percent = 0
            vram_used = 0
            vram_total = 0
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total", "--format=csv,noheader,nounits"],
                    text=True, timeout=3
                ).strip()
                if out:
                    line = out.splitlines()[0]
                    parts = [p.strip() for p in line.split(",") if p.strip()]
                    if len(parts) >= 5:
                        gpu_temp = round(float(parts[0]))
                        gpu_percent = round(float(parts[1]))
                        gpu_mem_percent = round(float(parts[2]))
                        vram_used = round(float(parts[3]))
                        vram_total = round(float(parts[4]))
                        _GPU_STATS["at"] = now
                        _GPU_STATS["value"] = (gpu_temp, gpu_percent, gpu_mem_percent, vram_used, vram_total)
            except Exception:
                pass

            # Fallback to PyTorch CUDA if nvidia-smi failed or returned 0
            if vram_total == 0:
                try:
                    import torch
                    if torch.cuda.is_available():
                        free_b, total_b = torch.cuda.mem_get_info()
                        vram_total = round(total_b / (1024 ** 2))
                        vram_used = round((total_b - free_b) / (1024 ** 2))
                        if vram_total > 0:
                            gpu_mem_percent = round((vram_used / vram_total) * 100)
                            vram_pct = round((vram_used / vram_total * 100), 1)
                        _GPU_STATS["at"] = now
                        _GPU_STATS["value"] = (gpu_temp, gpu_percent, gpu_mem_percent, vram_used, vram_total)
                except Exception:
                    pass

        vram_pct = round((vram_used / vram_total * 100), 1) if vram_total > 0 else 0
        hdd_path = request.query.get("hdd_path", os.path.sep)
        if not State.is_filesystem_root(hdd_path):
            return web.json_response(
                {"error": "hdd_path must be a drive root, as /livedev/drives reports them"},
                status=400)
        disk = shutil.disk_usage(hdd_path)
        disk_pct = round((disk.used / disk.total * 100), 1)

        # What ComfyUI itself is holding, kept apart from the machine's own figures. The server is
        # this process, so the allocator's numbers are ComfyUI's numbers and nobody else's - which is
        # what makes them worth showing next to the card's total instead of buried in a process row.
        comfy = {"models": 0, "vram_allocated_mb": 0, "vram_reserved_mb": 0, "device": "", "loaded": []}
        try:
            import comfy.model_management as model_management
            for entry in list(model_management.current_loaded_models or []):
                patcher = getattr(entry, "model", None)
                inner = getattr(patcher, "model", None)
                # The checkpoint's file name is not kept on the patcher, so the class name is what is
                # available. It answers the half of the question that matters - what kind of model is
                # loaded - and inventing a file name from anything else would be a guess.
                comfy["loaded"].append(type(inner).__name__ if inner is not None else "unknown")
            comfy["models"] = len(comfy["loaded"])
            comfy["device"] = str(model_management.get_torch_device())
        except Exception:
            pass
        try:
            import torch
            if torch.cuda.is_available():
                comfy["vram_allocated_mb"] = round(torch.cuda.memory_allocated() / (1024 ** 2))
                comfy["vram_reserved_mb"] = round(torch.cuda.memory_reserved() / (1024 ** 2))
        except Exception:
            pass

        return web.json_response({
            "cpu": {"percent": round(cpu, 1), "procPercent": round(proc_cpu, 1)},
            "ram": {"percent": round(ram.percent, 1), "used": round(ram.used / (1024**3), 1), "total": round(ram.total / (1024**3), 1)},
            "gpu": {"percent": gpu_percent, "temp": gpu_temp, "memPercent": gpu_mem_percent, "name": _GPU_DATA["name"]},
            "vram": {"percent": vram_pct, "used": vram_used, "total": vram_total},
            "hdd": {"percent": disk_pct, "used": round(disk.used / (1024**4), 1), "total": round(disk.total / (1024**4), 1)},
            "proc": {"cpu": round(proc_cpu, 1), "mem": round(proc_mem, 2)},
            "comfy": comfy,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/livedev/translate")
async def translate_text(request):
    """Translate one string through Google's public endpoint.

    The text leaves this machine, so the run is started by the user pressing Translate and the
    answer is what comes back - nothing else is sent and nothing is kept. The request body is not
    echoed to the console: the log would otherwise hold whatever the user was working on.
    """
    try:
        data = await request.json()
        text = data.get("q", "")
        source = data.get("source", "auto")
        target = data.get("target", "en")
        if not text:
            return web.json_response({"error": "No text provided"}, status=400)
        print(f"\033[94m[LiveDev] Translate request ({source}->{target}, {len(text)} chars)\033[0m")
        resp = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": source, "tl": target, "dt": "t", "q": text},
            timeout=10,
        )
        if resp.status_code != 200:
            print(f"\033[91m[LiveDev] Translate HTTP {resp.status_code}: {resp.text[:200]}\033[0m")
            return web.json_response({"error": f"Google Translate returned HTTP {resp.status_code}"}, status=502)
        resp_data = resp.json()
        translated = "".join(part[0] for part in resp_data[0] if part[0]) if isinstance(resp_data, list) and len(resp_data) > 0 and isinstance(resp_data[0], list) else ""
        if not translated:
            print(f"\033[91m[LiveDev] Translate parse failed: {str(resp_data)[:200]}\033[0m")
            return web.json_response({"error": "Could not parse translation response"}, status=502)
        return web.json_response({"translatedText": translated})
    except Exception as e:
        print(f"\033[91m[LiveDev] Translate error: {e}\033[0m")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/livedev/transcribe")
async def transcribe_audio(request):
    """Transcribe an uploaded clip. The chosen engine reaches the network.

    The browser's own Web Speech API is the default path and never comes here; this route exists
    for the browsers that have no such API, and it hands the audio to `SpeechRecognition`
    (`recognize_google`), so the recording leaves the machine. That only happens because the user
    pressed Record, and the audio is not written anywhere on disk.
    """
    try:
        import speech_recognition as sr
    except ImportError:
        return web.json_response(
            {"error": "Voice input needs the optional SpeechRecognition extra (see requirements.txt)"},
            status=500)
    try:
        data = await request.post()
        audio_field = data.get("audio")
        lang = data.get("lang", "en-US")
        if not audio_field:
            return web.json_response({"error": "No audio file"}, status=400)
        audio_bytes = audio_field.file.read()
        if len(audio_bytes) < 100:
            return web.json_response({"text": ""})
        import io, wave
        try:
            with wave.open(io.BytesIO(audio_bytes), 'rb') as wf:
                raw = wf.readframes(wf.getnframes())
                audio = sr.AudioData(raw, wf.getframerate(), wf.getsampwidth())
        except wave.Error:
            try:
                from pydub import AudioSegment
                seg = AudioSegment.from_file(io.BytesIO(audio_bytes))
                seg = seg.set_frame_rate(16000).set_channels(1).set_sample_width(2)
                buf = io.BytesIO()
                seg.export(buf, format="wav")
                buf.seek(0)
                with wave.open(buf, 'rb') as wf:
                    raw = wf.readframes(wf.getnframes())
                    audio = sr.AudioData(raw, wf.getframerate(), wf.getsampwidth())
            except ImportError:
                import subprocess, tempfile, os
                with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as tmp_in:
                    tmp_in.write(audio_bytes)
                    tmp_in_path = tmp_in.name
                tmp_out_path = tmp_in_path + '.wav'
                try:
                    subprocess.run(['ffmpeg', '-y', '-i', tmp_in_path, '-ar', '16000', '-ac', '1', tmp_out_path], capture_output=True, timeout=30)
                    with wave.open(tmp_out_path, 'rb') as wf:
                        raw = wf.readframes(wf.getnframes())
                        audio = sr.AudioData(raw, wf.getframerate(), wf.getsampwidth())
                finally:
                    # A temp file that is already gone is not a problem; anything else should not be
                    # hidden by the cleanup of a failed transcription.
                    try:
                        os.remove(tmp_in_path)
                    except OSError:
                        pass
                    try:
                        os.remove(tmp_out_path)
                    except OSError:
                        pass
        recognizer = sr.Recognizer()
        text = recognizer.recognize_google(audio, language=lang)
        return web.json_response({"text": text})
    except sr.UnknownValueError:
        return web.json_response({"text": ""})
    except sr.RequestError as e:
        return web.json_response({"error": f"RequestError: {e}"}, status=502)
    except Exception as e:
        print(f"\033[91m[LiveDev] Transcribe error: {e}\033[0m")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.get("/livedev/drives")
async def get_drives(request):
    try:
        if sys.platform == "win32":
            drives = []
            for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                path = letter + ":\\"
                if os.path.exists(path):
                    drives.append({"path": path, "label": letter + ":\\"})
            return web.json_response(drives)
        else:
            return web.json_response([{"path": "/", "label": "/"}])
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/reload_history")
async def get_reload_history(request):
    return web.json_response({"history": list(State.RELOAD_HISTORY)})


@PromptServer.instance.routes.post("/livedev/reload_now")
async def reload_now(request):
    try:
        data = await request.json()
        module = (data.get("module") or "").strip()
        if not module:
            return web.json_response({"error": "No module name provided"}, status=400)
        if not State.is_safe_module_name(module):
            return web.json_response({"error": "Invalid module name"}, status=400)
        reloader = State.ACTIVE_RELOADER
        if not reloader:
            return web.json_response({"error": "Reloader not ready"}, status=500)
        result = await asyncio.to_thread(reloader.force_reload, module)
        return web.json_response({"ok": True, "result": result})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/reload_all")
async def reload_all(request):
    """Reload every watched module.

    For a change that is not inside one pack: a helper several of them import, or a shared file. A
    targeted reload would leave the packs that imported the old object still holding it, so the only
    honest answer there is to reload them all.
    """
    reloader = State.ACTIVE_RELOADER
    if not reloader:
        return web.json_response({"error": "Reloader not ready"}, status=500)
    modules = [name for name in State.list_custom_node_modules()
               if name != State.LIVEDEV_SELF_MODULE and name not in State.EXCLUDE_MODULES]
    try:
        print(f"\033[94m[LiveDev] Reload All: {len(modules)} modules\033[0m")
        reloaded = await asyncio.to_thread(reloader.reload_many, modules)
        print(f"\033[92m[LiveDev] Reload All finished: {len(reloaded)}/{len(modules)} reloaded\033[0m")
        return web.json_response({"ok": True, "reloaded": reloaded})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/terminal_watch")
async def terminal_watch(request):
    """How many Terminal nodes the browser currently has, so the log tail can idle.

    The node's own thread used to read the log file every second for the life of the server, whether
    or not a Terminal existed to receive it. The browser is the only thing that knows, so it says.
    """
    try:
        data = await request.json()
        State.TERMINAL_WATCHERS["count"] = max(0, int(data.get("count") or 0))
        return web.json_response({"ok": True, "count": State.TERMINAL_WATCHERS["count"]})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/toggle_watch")
async def toggle_watch(request):
    try:
        data = await request.json()
        if "paused" in data:
            State.WATCH_PAUSED = bool(data.get("paused"))
        else:
            State.WATCH_PAUSED = not State.WATCH_PAUSED
        # Session only: watching starts paused on the next run whatever is chosen here.
        State.record_reload("watch", "paused" if State.WATCH_PAUSED else "resumed")
        return web.json_response({"paused": State.WATCH_PAUSED})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/rollback")
async def rollback_module(request):
    try:
        data = await request.json()
        module = (data.get("module") or "").strip()
        if not State.is_safe_module_name(module):
            return web.json_response({"error": "Invalid module name"}, status=400)
        backup_dir = State.LAST_BACKUPS.get(module)
        if not backup_dir or not os.path.isdir(backup_dir):
            return web.json_response({"error": "No backup available for this module"}, status=404)
        module_path = os.path.join(State.CUSTOM_NODE_ROOT[0], module)
        if os.path.isdir(module_path):
            shutil.rmtree(module_path)
            shutil.copytree(backup_dir, module_path)
        else:
            src = os.path.join(backup_dir, os.path.basename(module_path))
            if os.path.isfile(src):
                shutil.copy2(src, module_path)
        reloader = State.ACTIVE_RELOADER
        if reloader:
            await asyncio.to_thread(reloader.force_reload, module)
        State.record_reload(module, "rolled-back", details=f"Restored from {backup_dir}")
        return web.json_response({"ok": True, "restored": module, "from": backup_dir})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/console")
async def get_console(request):
    return web.json_response({"lines": list(State.CONSOLE_BUFFER)})


@PromptServer.instance.routes.post("/livedev/repl")
async def repl_exec(request):
    """Run a snippet in the server process - only when the owner has enabled it.

    The environment exposes `nodes`, `folder_paths` and `__builtins__`, so this is a full shell over
    HTTP, not a sandbox. It is off by default and the answer says how to turn it on, because the
    request carries no credentials and the port is open to the local browser.
    """
    if not State.LIVEDEV_ENABLE_REPL:
        return web.json_response(
            {"ok": False, "error": "The REPL is off. Set State.LIVEDEV_ENABLE_REPL=1 and restart the "
                                   "server to enable it."},
            status=403,
        )
    try:
        data = await request.json()
        code = data.get("code", "")
        if not code or not code.strip():
            return web.json_response({"ok": False, "error": "No code provided"}, status=400)
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid request"}, status=400)

    result = {"ok": True, "stdout": "", "result": "", "error": "", "traceback": ""}

    def _run():
        buf = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        env = {
            "nodes": nodes,
            "folder_paths": folder_paths,
            "os": os,
            "sys": sys,
            "json": json,
            "time": time,
            "requests": requests,
            "__builtins__": __builtins__,
        }
        try:
            sys.stdout, sys.stderr = buf, buf
            try:
                value = eval(code, env)
                result["result"] = repr(value)
            except SyntaxError:
                exec(compile(code, "<livedev_repl>", "exec"), env)
        except Exception as e:
            result["ok"] = False
            result["error"] = f"{type(e).__name__}: {e}"
            result["traceback"] = traceback.format_exc()
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            result["stdout"] = buf.getvalue()

    try:
        await asyncio.to_thread(_run)
    except Exception as e:
        result["ok"] = False
        result["error"] = f"{type(e).__name__}: {e}"
    return web.json_response(result)


@PromptServer.instance.routes.get("/livedev/health")
async def get_health(request):
    try:
        proc = psutil.Process()
        mem_mb = round(proc.memory_info().rss / (1024**2), 1)
        cache_size = 0
        try:
            hc = getattr(caching, "HierarchicalCache", None)
            cks = getattr(hc, "cache_key_set", None)
            cache_size = len(cks.keys) if cks and hasattr(cks, "keys") else 0
        except Exception:
            cache_size = 0
        return web.json_response(
            {
                "watchedModules": len(State.list_custom_node_modules()),
                "routes": len(PromptServer.instance.routes),
                "sysModules": len(sys.modules),
                "reloadHistoryCount": len(State.RELOAD_HISTORY),
                "watchPaused": State.WATCH_PAUSED,
                "memMb": mem_mb,
                "cacheKeys": cache_size,
                "lastReloads": list(State.RELOAD_HISTORY)[-5:],
                "backups": {k: v for k, v in list(State.LAST_BACKUPS.items())[-5:]},
                # What the pack's behaviour is actually set to on this run. Five environment variables
                # decide it and nothing in the interface used to say what they were, so every question
                # about why something did or did not reload started with a guess.
                "environment": {
                    "excluded": sorted(State.EXCLUDE_MODULES),
                    "observeOnly": sorted(State.LIVEDEV_OBSERVE_ONLY),
                    "extensions": sorted(State.LIVEDEV_EXTENSIONS),
                    "debounceSeconds": State.DEBOUNCE_TIME,
                    "replEnabled": State.LIVEDEV_ENABLE_REPL,
                    "terminalWatchers": State.TERMINAL_WATCHERS["count"],
                    "startWatching": not State.WATCH_PAUSED,
                    "reloadDependents": State.RELOAD_DEPENDENTS,
                    "ignorePatterns": list(State.IGNORE_PATTERNS),
                    "historySize": State.RELOAD_HISTORY.maxlen,
                    "consoleSize": State.CONSOLE_BUFFER.maxlen,
                    "conflictTtl": State.CONFLICT_TTL,
                },
            }
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/self_test")
async def self_test(request):
    """Prove the reload path with a throwaway module, built inside this pack.

    The module has to be a real folder on disk for `load_custom_node` to walk, but it belongs to
    the pack that is testing itself: creating it in custom_nodes put a folder into the user's
    installation that this pack did not own and then deleted it. The watcher already ignores this
    pack and every `_`-prefixed name, so the test cannot trigger the reload it is measuring.
    """
    test_name = "_livedev_selftest"
    test_dir = os.path.join(State.PACK_ROOT, test_name)
    results: dict = {"ok": True, "steps": [], "errors": [], "leaks": {}}
    try:
        os.makedirs(test_dir, exist_ok=True)
        init_path = os.path.join(test_dir, "__init__.py")
        if not os.path.exists(init_path):
            cls_src = (
                "class LiveDev_SelfTestNode:\n"
                "    @classmethod\n"
                "    def INPUT_TYPES(cls):\n"
                '        return {"required": {}}\n'
                '    RETURN_TYPES = ("STRING",)\n'
                '    FUNCTION = "run"\n'
                '    CATEGORY = "LiveDev/Test"\n'
                "    def run(self):\n"
                '        return ("ok",)\n'
                'NODE_CLASS_MAPPINGS = {"LiveDev_SelfTestNode": LiveDev_SelfTestNode}\n'
                'NODE_DISPLAY_NAME_MAPPINGS = {"LiveDev_SelfTestNode": "LiveDev SelfTest"}\n'
            )
            with open(init_path, "w", encoding="utf-8") as fh:
                fh.write(cls_src)
        routes_before = len(PromptServer.instance.routes)
        sysmods_before = len(sys.modules)
        ok_iterations = 0
        for i in range(3):
            try:
                ok = await load_custom_node(test_dir)
                if ok:
                    ok_iterations += 1
            except Exception as e:
                results["errors"].append(f"iteration {i + 1}: {e}")
        results["steps"].append(
            {
                "name": "reload x3",
                "ok": ok_iterations == 3,
                "detail": f"{ok_iterations}/3 succeeded",
            }
        )
        for name in list(sys.modules):
            if test_name in name:
                del sys.modules[name]
        nodes.NODE_CLASS_MAPPINGS.pop("LiveDev_SelfTestNode", None)
        nodes.NODE_DISPLAY_NAME_MAPPINGS.pop("LiveDev_SelfTestNode", None)
        routes_after = len(PromptServer.instance.routes)
        sysmods_after = len(sys.modules)
        results["leaks"] = {
            "routes": routes_after - routes_before,
            "sysModules": sysmods_after - sysmods_before,
        }
        results["steps"].append(
            {
                "name": "leak check",
                "ok": results["leaks"]["routes"] == 0
                and results["leaks"]["sysModules"] <= 3,
                "detail": str(results["leaks"]),
            }
        )
        results["ok"] = all(s["ok"] for s in results["steps"])
    except Exception as e:
        results["ok"] = False
        results["errors"].append(str(e))
    finally:
        for name in list(sys.modules):
            if test_name in name:
                del sys.modules[name]
        nodes.NODE_CLASS_MAPPINGS.pop("LiveDev_SelfTestNode", None)
        nodes.NODE_DISPLAY_NAME_MAPPINGS.pop("LiveDev_SelfTestNode", None)
        shutil.rmtree(test_dir, ignore_errors=True)
    return web.json_response(results)


@PromptServer.instance.routes.post("/livedev/node_source")
async def node_source(request):
    try:
        data = await request.json()
        node_type = (data.get("node_type") or "").strip()
        if not node_type:
            return web.json_response({"error": "No node_type provided"}, status=400)
        cls = nodes.NODE_CLASS_MAPPINGS.get(node_type)
        if not cls:
            return web.json_response({"error": f"Unknown node type: {node_type}"}, status=404)
        module = sys.modules.get(getattr(cls, "__module__", ""))
        path = getattr(module, "__file__", None) if module else None
        if not path or not os.path.isfile(path):
            return web.json_response({"error": "Source file not found"}, status=404)
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
        return web.json_response({"ok": True, "path": path, "source": src})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/node_module")
async def node_module(request):
    try:
        data = await request.json()
        node_type = (data.get("node_type") or "").strip()
        cls = nodes.NODE_CLASS_MAPPINGS.get(node_type)
        if not cls:
            return web.json_response({"error": f"Unknown node type: {node_type}"}, status=404)
        module = sys.modules.get(getattr(cls, "__module__", ""))
        path = getattr(module, "__file__", None) if module else None
        result = None
        if path:
            ap = os.path.abspath(path)
            for root in State.CUSTOM_NODE_ROOT:
                ar = os.path.abspath(root)
                if ap.startswith(ar + os.sep):
                    result = os.path.relpath(ap, ar).split(os.sep)[0]
                    break
        return web.json_response({"module": result})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ============================================================================
# LiveDev Dependency Management Routes
# ============================================================================

@PromptServer.instance.routes.get("/livedev/deps/list_projects")
async def deps_list_projects(request):
    """List all custom node project folders."""
    try:
        loop = asyncio.get_event_loop()
        projects = await loop.run_in_executor(None, DependencyManager.list_all_custom_node_projects)
        return web.json_response({"ok": True, "projects": projects})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/deps/scan_all")
async def deps_scan_all(request):
    """Scan all installed custom nodes for missing or conflicting packages."""
    try:
        include_clean = request.query.get("include_clean", "false").lower() in ("true", "1", "yes")
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, DependencyManager.scan_all_custom_nodes, include_clean)
        return web.json_response({"ok": True, "results": results})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/deps/scan_node")
async def deps_scan_node(request):
    """Scan a specific custom node for missing or conflicting packages."""
    try:
        data = await request.json()
        node_name = (data.get("node_name") or "").strip()
        if not node_name:
            return web.json_response({"ok": False, "error": "No node_name provided"}, status=400)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, DependencyManager.scan_node_dependencies, node_name)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/deps/install")
async def deps_install_package(request):
    """Install a single package into the active Python environment with safety checks."""
    try:
        data = await request.json()
        raw_package = (data.get("package") or "").strip()
        node_name = (data.get("node_name") or "").strip()
        force = bool(data.get("force", False))
        no_deps = bool(data.get("no_deps", False))

        if not raw_package:
            return web.json_response({"ok": False, "error": "No package specified"}, status=400)

        # Safety check: prevent accidental replacement/downgrade of critical core packages
        canonical = DependencyManager.canonical_name(raw_package.split("=")[0].split("<")[0].split(">")[0].split("~")[0].split("!")[0])
        if canonical in DependencyManager.CRITICAL_CORE_PACKAGES and not force:
            return web.json_response({
                "ok": False,
                "error": f"Package '{canonical}' is a critical ComfyUI core package. Automatic installation is blocked to protect CUDA acceleration and environment stability. Use force option if explicitly required."
            }, status=400)

        extra_args = []
        if no_deps:
            extra_args.append("--no-deps")

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, DependencyManager.install_package, raw_package, extra_args, node_name
        )
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/deps/conflict_log")
async def deps_get_conflict_log(request):
    """Return recorded install/conflict rollback snapshots."""
    try:
        loop = asyncio.get_event_loop()
        log = await loop.run_in_executor(None, DependencyManager.load_conflict_log)
        return web.json_response({"ok": True, "log": log})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/livedev/deps/rollback")
async def deps_rollback_package(request):
    """Roll back a package to its recorded pre-install version (or uninstall if newly added)."""
    try:
        data = await request.json()
        canonical_name = (data.get("canonical_name") or "").strip()
        if not canonical_name:
            return web.json_response({"ok": False, "error": "No canonical_name provided"}, status=400)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, DependencyManager.rollback_package, canonical_name)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/livedev/deps/installed")
async def deps_get_installed(request):
    """Return all currently installed packages in the environment."""
    try:
        loop = asyncio.get_event_loop()
        installed = await loop.run_in_executor(None, DependencyManager.get_installed_packages, True)
        return web.json_response({"ok": True, "installed": installed})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

